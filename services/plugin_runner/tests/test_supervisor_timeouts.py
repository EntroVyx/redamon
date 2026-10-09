"""A timeout kills the worker (the only way to stop Python code for sure) and a new one
replaces it; the effective timeout is the smallest of the request, the manifest and
PLUGIN_ACTION_MAX_TIMEOUT (D-16, R-10)."""

import threading
import time

from tests.support import install_plugin, pid_alive, wait_until


def test_a_sync_timeout_is_504_and_the_worker_is_replaced(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    before = h.health()["workers"][0]
    started = time.time()
    r = h.act("echo", "sleep", {"seconds": 30}, timeout=1)
    assert r.status_code == 504 and r.json()["code"] == "action_timeout"
    assert time.time() - started < 5
    wait_until(lambda: h.restarted_from(before["pid"]))
    assert not pid_alive(before["pid"])
    assert h.health()["workers"][0]["restarts"] == before["restarts"] + 1
    after = h.act("echo", "echo")
    assert after.status_code == 200 and after.json()["ok"] is True, after.text


def test_other_calls_on_a_killed_worker_fail_with_worker_restarted(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)], max_concurrent=4)
    out = {}

    def long_call():
        out["long"] = h.act("echo", "sleep", {"seconds": 20}, timeout=20)

    t = threading.Thread(target=long_call)
    t.start()
    wait_until(lambda: h.health()["workers"][0]["inFlight"] == 1)
    r = h.act("echo", "sleep", {"seconds": 20}, timeout=1)
    assert r.status_code == 504
    t.join(10)
    assert out["long"].status_code == 502 and out["long"].json()["code"] == "worker_restarted"


def test_the_platform_cap_bounds_the_request(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)], action_max_timeout=1)
    started = time.time()
    r = h.act("echo", "sleep", {"seconds": 30}, timeout=100)
    assert r.status_code == 504
    assert time.time() - started < 5


def test_the_manifest_bounds_the_request(runner, plugins_dir):
    entry = install_plugin(plugins_dir, action_changes={"sleep": {"timeoutSeconds": 1}})
    h = runner([entry])
    started = time.time()
    r = h.act("echo", "sleep", {"seconds": 30}, timeout=100)
    assert r.status_code == 504
    assert time.time() - started < 5


def test_a_fast_action_is_not_affected_by_a_short_timeout(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    assert h.act("echo", "echo", timeout=1).json()["ok"] is True
