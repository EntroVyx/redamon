"""Actions through the supervisor: lookup in the run list's manifest, the per-worker
concurrency limit, results and errors, and a crashed worker coming back (D-15, D-16)."""

import os
import threading
import time

from tests.support import install_plugin, pid_alive, wait_until


def test_a_sync_action_returns_its_result(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.act("echo", "echo", {"a": 1}, ctx={"pluginId": "echo", "version": "1.0.0", "userId": "u1",
                                             "projectId": "p1"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "result": {"echo": {"a": 1}, "plugin": "echo", "version": "1.0.0",
                                               "user": "u1", "project": "p1", "session": None, "job": None}}


def test_a_plugin_error_is_a_result_not_a_runner_failure(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.act("echo", "raise_plugin_error", {"code": "no_target", "message": "Pick one."})
    assert r.status_code == 200
    assert r.json() == {"ok": False, "error": {"code": "no_target", "message": "Pick one."}}


def test_unknown_plugin_and_unknown_action_are_404(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.act("nobody", "echo")
    assert r.status_code == 404 and r.json()["code"] == "unknown_plugin"
    r = h.act("echo", "not_declared")
    assert r.status_code == 404 and r.json()["code"] == "unknown_action"


def test_the_entry_comes_from_the_manifest_never_from_the_request(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    body = {"token": "t", "params": {}, "timeoutSeconds": 5, "async": False,
            "ctx": {"pluginId": "echo", "version": "1.0.0", "userId": "u"},
            "entry": "engine/main.py:crash"}
    r = h.post("/runner/v1/plugins/echo/actions/echo", json=body)
    assert r.status_code == 200 and r.json()["ok"] is True


def test_a_malformed_body_is_400(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    for body in ({}, {"token": "", "params": {}, "timeoutSeconds": 5, "ctx": {}},
                 {"token": "t", "params": [], "timeoutSeconds": 5, "ctx": {}},
                 {"token": "t", "params": {}, "timeoutSeconds": 0, "ctx": {}}):
        r = h.post("/runner/v1/plugins/echo/actions/echo", json=body)
        assert r.status_code == 400 and r.json()["code"] == "bad_request", (body, r.text)


def test_a_busy_worker_answers_429(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)], max_concurrent=1)
    started = threading.Event()
    out = {}

    def slow():
        started.set()
        out["slow"] = h.act("echo", "sleep", {"seconds": 1.5}, timeout=10)

    t = threading.Thread(target=slow)
    t.start()
    started.wait()
    wait_until(lambda: h.health()["workers"][0]["inFlight"] == 1)
    r = h.act("echo", "echo")
    assert r.status_code == 429 and r.json()["code"] == "plugin_busy"
    t.join()
    assert out["slow"].status_code == 200
    assert h.act("echo", "echo").status_code == 200


def test_a_crash_is_502_and_the_worker_comes_back(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    before = h.health()["workers"][0]
    r = h.act("echo", "crash")
    assert r.status_code == 502 and r.json()["code"] == "worker_crashed"
    wait_until(lambda: h.restarted_from(before["pid"]))
    after = h.health()["workers"][0]
    assert after["restarts"] == before["restarts"] + 1
    assert not pid_alive(before["pid"])
    assert h.act("echo", "echo").json()["ok"] is True


def test_concurrent_actions_share_one_worker(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)], max_concurrent=4)
    results = []

    def call(i):
        results.append(h.act("echo", "sleep", {"seconds": 0.5}).json())

    threads = [threading.Thread(target=call, args=(i,)) for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r["ok"] for r in results] == [True, True, True]
    assert len(h.health()["workers"]) == 1


def test_stopping_the_supervisor_stops_its_workers(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    pid = h.health()["workers"][0]["pid"]
    h.__exit__(None, None, None)
    wait_until(lambda: not pid_alive(pid))


def _worker_processes(under: str) -> list:
    found = []
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                with open(f"/proc/{name}/cmdline", "rb") as f:
                    cmd = f.read().decode("utf-8", "replace")
            except OSError:
                continue
            if "bootstrap.py" in cmd and under in cmd:
                found.append(int(name))
    return found


def test_stopping_during_a_restart_leaves_no_worker(runner, plugins_dir):
    """The supervisor stopping while a crashed worker restarts must not leave the new
    process behind (a restart in progress is cancelled, a process it started is stopped)."""
    for _ in range(3):
        h = runner([install_plugin(plugins_dir, f"echo-{_}")])
        assert h.act(f"echo-{_}", "crash", ctx={"pluginId": f"echo-{_}", "version": "1.0.0",
                                               "userId": "u"}).status_code == 502
        started = time.time()
        h.__exit__(None, None, None)
        assert time.time() - started < 10
        wait_until(lambda: not _worker_processes(str(plugins_dir / f"echo-{_}")))
