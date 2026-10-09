"""The run list: the supervisor asks the webapp which plugins to run and converges its
workers on it (README.PLUGINS.md §7.2, D-38)."""

from tests.support import RUNNER_KEY, install_plugin, pid_alive, run_list, wait_until


def test_the_run_list_is_fetched_with_the_runner_key(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    req = [r for r in h.stub.requests if r.path == "/api/plugin-runner/v1/run-list"][0]
    assert req.method == "GET"
    assert req.headers["x-plugin-runner-key"] == RUNNER_KEY


def test_a_listed_plugin_gets_a_worker_at_start(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    health = h.health()
    assert health["state"] == "ok"
    assert health["platformVersion"] == "1.0.0"
    assert [(w["id"], w["version"]) for w in health["workers"]] == [("echo", "1.0.0")]
    w = health["workers"][0]
    assert pid_alive(w["pid"]) and w["inFlight"] == 0 and w["restarts"] == 0 and w["startedAt"]


def test_a_removed_plugin_is_stopped(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    pid = h.health()["workers"][0]["pid"]
    h.run_list = run_list([])
    h.reload()
    assert h.health()["workers"] == []
    wait_until(lambda: not pid_alive(pid))


def test_a_new_version_replaces_the_old_worker(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    old = h.health()["workers"][0]["pid"]
    h.run_list = run_list([install_plugin(plugins_dir, version="1.0.1")])
    h.reload()
    assert [(w["id"], w["version"]) for w in h.health()["workers"]] == [("echo", "1.0.1")]
    wait_until(lambda: not pid_alive(old))
    new_ctx = {"pluginId": "echo", "version": "1.0.1", "userId": "u"}
    assert h.act("echo", "echo", {"v": 2}, ctx=new_ctx).json()["result"]["echo"] == {"v": 2}
    # A call minted for the replaced version is not run on the new one.
    assert h.act("echo", "echo").json()["code"] == "unknown_plugin"


def test_an_unchanged_list_keeps_the_same_workers(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    pid = h.health()["workers"][0]["pid"]
    h.reload()
    assert h.health()["workers"][0]["pid"] == pid


def test_a_different_platform_version_means_out_of_date_and_no_workers(runner, plugins_dir):
    entry = install_plugin(plugins_dir)
    h = runner([entry])
    pid = h.health()["workers"][0]["pid"]
    h.run_list = run_list([entry], platform="2.0.0")
    h.reload()
    health = h.health()
    assert health["state"] == "out_of_date"
    assert health["workers"] == []
    wait_until(lambda: not pid_alive(pid))
    r = h.act("echo", "echo")
    assert r.status_code == 503 and r.json()["code"] == "runner_out_of_date"


def test_an_unreachable_webapp_keeps_the_last_good_list(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    pid = h.health()["workers"][0]["pid"]
    h.run_list_status = 500
    h.reload()
    health = h.health()
    assert health["state"] == "degraded"
    assert [w["pid"] for w in health["workers"]] == [pid]
    assert h.act("echo", "echo").status_code == 200
    h.run_list_status = 200
    h.reload()
    assert h.health()["state"] == "ok"


def test_an_unreachable_webapp_at_start_is_degraded_with_no_workers(runner, plugins_dir):
    from tests.support import free_port
    h = runner([install_plugin(plugins_dir)], gateway_url=f"http://127.0.0.1:{free_port()}")
    health = h.health()
    assert health["state"] == "degraded" and health["workers"] == []


def test_entries_that_do_not_fit_the_volume_layout_are_skipped(runner, plugins_dir):
    good = install_plugin(plugins_dir)
    elsewhere = dict(install_plugin(plugins_dir, "echo-two"), root="/tmp")
    missing = {"id": "ghost", "version": "1.0.0", "manifest": good["manifest"],
               "root": str(plugins_dir / "ghost" / "versions" / "1.0.0")}
    bad_id = dict(good, id="Bad_Id")
    traversal = dict(install_plugin(plugins_dir, "echo-three"),
                     root=str(plugins_dir / "echo-three" / "versions" / "1.0.0" / ".." / "1.0.0"))
    no_manifest = dict(install_plugin(plugins_dir, "echo-four"), manifest="nope")
    h = runner([good, elsewhere, missing, bad_id, traversal, no_manifest])
    assert [w["id"] for w in h.health()["workers"]] == ["echo"]


def test_the_list_is_reloaded_periodically(runner, plugins_dir):
    h = runner([], reload_interval=0.3)
    assert h.health()["workers"] == []
    h.run_list = run_list([install_plugin(plugins_dir)])
    wait_until(lambda: h.health()["workers"], timeout=30)


def test_two_plugins_get_two_workers(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir), install_plugin(plugins_dir, "echo-two")])
    workers = h.workers()
    assert set(workers) == {"echo@1.0.0", "echo-two@1.0.0"}
    assert workers["echo@1.0.0"]["pid"] != workers["echo-two@1.0.0"]["pid"]
