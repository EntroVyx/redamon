"""How a worker reports what an action did wrong (README.PLUGINS.md §7.7): a PluginError
keeps its code and message, anything else is a generic internal error whose details go
only to the plugin's log."""

import shutil
import time

from tests.support import ECHO_ROOT

GENERIC = {"code": "internal_plugin_error", "message": "The plugin failed. Details are in its log."}


def _plugin_with(tmp_path, source: str):
    root = tmp_path / "p"
    shutil.copytree(ECHO_ROOT, root)
    (root / "engine" / "extra.py").write_text(source)
    return root


def _wait_for(lines, text, seconds=3.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if any(text in line for line in lines):
            return True
        time.sleep(0.05)
    return False


def test_a_plugin_error_keeps_code_and_message(worker):
    w = worker()
    w.ready()
    out = w.call("raise_plugin_error", {"code": "target_unknown", "message": "Pick a target first."})
    assert out == {"type": "result", "id": "r1", "ok": False,
                   "error": {"code": "target_unknown", "message": "Pick a target first."}}


def test_any_other_exception_is_generic_and_its_traceback_goes_to_the_log(worker):
    w = worker()
    w.ready()
    out = w.call("raise_other")
    assert out["ok"] is False and out["error"] == GENERIC
    assert _wait_for(w.stderr_lines, "RuntimeError")
    assert any("4242" in line for line in w.stderr_lines)
    assert "4242" not in str(out)


def test_a_function_that_is_not_async_is_refused(worker):
    w = worker()
    w.ready()
    out = w.call("not_async")
    assert out["ok"] is False and out["error"]["code"] == "invalid_entry"
    assert "async def" in out["error"]["message"]


def test_a_result_over_two_megabytes_is_refused(worker):
    w = worker()
    w.ready()
    out = w.call("big_result", {"bytes": 3 * 1024 * 1024})
    assert out["ok"] is False and out["error"]["code"] == "result_too_large"
    out = w.call("big_result", {"bytes": 1024 * 1024}, req_id="r2")
    assert out["ok"] is True and len(out["result"]["blob"]) == 1024 * 1024


def test_a_result_that_is_not_a_json_object_is_refused(worker, tmp_path):
    root = _plugin_with(tmp_path, (
        "async def a_list(ctx, params):\n    return [1, 2]\n\n"
        "async def a_set(ctx, params):\n    return {'s': {1, 2}}\n\n"
        "async def a_nan(ctx, params):\n    return {'n': float('nan')}\n"))
    w = worker(root)
    w.ready()
    for i, fn in enumerate(("a_list", "a_set", "a_nan")):
        out = w.call(fn, entry=f"engine/extra.py:{fn}", req_id=f"r{i}")
        assert out["ok"] is False and out["error"]["code"] == "invalid_result", (fn, out)


def test_a_malformed_plugin_error_code_is_replaced(worker, tmp_path):
    root = _plugin_with(tmp_path, (
        "from redamon_plugin_sdk import PluginError\n\n"
        "async def run(ctx, params):\n    raise PluginError('Not A Code!', 'm' * 5000)\n"))
    w = worker(root)
    w.ready()
    out = w.call("x", entry="engine/extra.py:run")
    assert out["error"]["code"] == "plugin_error"
    assert len(out["error"]["message"]) == 2000


def test_cancel_stops_the_running_action(worker):
    w = worker()
    w.ready()
    w.invoke("sleep", {"seconds": 30}, req_id="long")
    time.sleep(0.2)
    started = time.time()
    w.send({"type": "cancel", "id": "long"})
    out = w.next_message(timeout=5)
    assert out == {"type": "result", "id": "long", "ok": False,
                   "error": {"code": "cancelled", "message": "The action was cancelled."}}
    assert time.time() - started < 2
    assert w.call("echo", req_id="after")["ok"] is True


def test_cancel_of_an_unknown_request_is_ignored(worker):
    w = worker()
    w.ready()
    w.send({"type": "cancel", "id": "never-sent"})
    assert w.call("echo", req_id="r2")["ok"] is True


def test_a_crash_ends_the_worker_without_an_answer(worker):
    w = worker()
    w.ready()
    w.invoke("crash", {"code": 3})
    assert w.next_message(timeout=5) is None
    assert w.proc.wait(5) == 3


def test_an_import_error_in_plugin_code_is_generic(worker, tmp_path):
    root = _plugin_with(tmp_path, "import not_a_module_anywhere\n\nasync def run(ctx, params):\n    return {}\n")
    w = worker(root)
    w.ready()
    out = w.call("x", entry="engine/extra.py:run")
    assert out["ok"] is False and out["error"] == GENERIC
    assert _wait_for(w.stderr_lines, "not_a_module_anywhere")
