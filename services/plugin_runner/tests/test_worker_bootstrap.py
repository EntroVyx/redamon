"""worker/bootstrap.py: how a plugin worker starts (path, limits, environment) and how it
speaks to the supervisor. Started exactly as the supervisor starts it: `python -I -S`,
JSON requests on stdin, answers on a separate protocol fd."""

import os
import shutil
import stat
import sys
import time

import pytest

from tests.support import ECHO_ROOT, SDK_ROOT, WorkerProcess


def _copy_echo(tmp_path):
    root = tmp_path / "echo"
    shutil.copytree(ECHO_ROOT, root)
    return root


def test_the_worker_announces_itself(worker):
    w = worker()
    msg = w.ready()
    assert msg["pid"] == w.proc.pid


def test_sys_path_is_the_sdk_the_plugin_and_its_vendor_folder_then_stdlib(worker):
    w = worker()
    w.ready()
    out = w.call("describe")
    assert out["ok"], out
    path = out["result"]["sysPath"]
    assert path[:3] == [str(SDK_ROOT), str(ECHO_ROOT), str(ECHO_ROOT / "vendor")]
    assert not any("site-packages" in p or "dist-packages" in p for p in path)
    assert all(p.startswith(sys.base_prefix) for p in path[3:]), path[3:]
    assert out["result"]["flags"] == {"isolated": 1, "no_site": 1}


def test_site_packages_are_not_importable(worker):
    import pytest as visible_here  # noqa: F401  (installed in this image's site-packages)
    w = worker()
    w.ready()
    out = w.call("import_site_package", {"module": "pytest"})
    assert out["result"] == {"module": "pytest", "importable": False}
    out = w.call("import_site_package", {"module": "json"}, req_id="r2")
    assert out["result"] == {"module": "json", "importable": True}


def test_a_vendored_module_is_importable(worker, tmp_path):
    root = _copy_echo(tmp_path)
    (root / "vendor").mkdir()
    (root / "vendor" / "helperlib.py").write_text("VALUE = 'vendored'\n")
    (root / "engine" / "uses_vendor.py").write_text(
        "import helperlib\n\nasync def run(ctx, params):\n    return {'value': helperlib.VALUE}\n")
    w = worker(root)
    w.ready()
    out = w.call("x", entry="engine/uses_vendor.py:run")
    assert out == {"type": "result", "id": "r1", "ok": True, "result": {"value": "vendored"}}


def test_noise_on_stdout_does_not_break_the_protocol(worker):
    w = worker()
    w.ready()
    out = w.call("print_noise")
    assert out == {"type": "result", "id": "r1", "ok": True, "result": {"printed": True}}
    out = w.call("echo", {"a": 1}, req_id="r2")
    assert out["ok"] and out["result"]["echo"] == {"a": 1}
    deadline = time.time() + 2
    while time.time() < deadline and not any("fd 1" in line for line in w.stderr_lines):
        time.sleep(0.05)
    joined = "\n".join(w.stderr_lines)
    assert "noise on stdout {not json" in joined
    assert "noise written to fd 1" in joined
    assert w.stdout_lines == []


def test_limits_temp_dir_and_priority_are_applied_before_plugin_code(worker):
    w = worker(mem_mb=384, nproc=48)
    w.ready()
    r = w.call("describe")["result"]
    mib = 1024 * 1024
    assert r["rlimits"]["RLIMIT_AS"] == [384 * mib, 384 * mib]
    assert r["rlimits"]["RLIMIT_NPROC"] == [48, 48]
    assert r["rlimits"]["RLIMIT_NOFILE"] == [256, 256]
    assert r["rlimits"]["RLIMIT_CORE"] == [0, 0]
    assert r["rlimits"]["RLIMIT_FSIZE"] == [64 * mib, 64 * mib]
    assert r["dumpable"] == 0
    assert r["nice"] >= 10
    assert r["home"] == r["tmpdir"] == r["cwd"]
    assert r["tmpdir"].startswith("/tmp/")
    assert r["tmpMode"] == 0o700
    assert r["tmpOwner"] == r["uid"]


def test_the_environment_is_what_the_supervisor_passed_plus_home_and_tmpdir(worker):
    w = worker()
    w.ready()
    env = w.call("describe")["result"]["env"]
    assert set(env) == {"PATH", "LANG", "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED",
                        "REDAMON_GATEWAY_URL", "HOME", "TMPDIR"}


def test_actions_of_one_worker_run_concurrently(worker):
    w = worker()
    w.ready()
    w.invoke("sleep", {"seconds": 1.0}, req_id="slow")
    w.invoke("echo", {"n": 1}, req_id="fast")
    first = w.next_message()
    second = w.next_message()
    assert (first["id"], second["id"]) == ("fast", "slow")
    assert second["result"] == {"slept": 1.0}


def test_the_context_reaches_the_action(worker):
    w = worker()
    w.ready()
    out = w.call("echo", {"x": 1}, ctx={"pluginId": "echo", "version": "1.0.0", "userId": "u7",
                                         "projectId": "p7", "sessionId": "s7", "jobId": "j7"})
    assert out["result"] == {"echo": {"x": 1}, "plugin": "echo", "version": "1.0.0", "user": "u7",
                             "project": "p7", "session": "s7", "job": "j7"}


@pytest.mark.parametrize("entry", [
    "engine/../plugin.py:echo",
    "engine//main.py:echo",
    "engine/main.py:../echo",
    "ui/home.py:echo",
    "/etc/passwd:echo",
    "engine/main.py",
    "engine/Main.py:echo",
])
def test_an_entry_outside_the_engine_folder_is_refused(worker, entry):
    w = worker()
    w.ready()
    out = w.call("echo", entry=entry)
    assert out["ok"] is False and out["error"]["code"] == "invalid_entry", out


def test_an_entry_that_resolves_outside_engine_through_a_symlink_is_refused(worker, tmp_path):
    root = _copy_echo(tmp_path)
    (tmp_path / "outside.py").write_text("async def run(ctx, params):\n    return {'escaped': True}\n")
    os.symlink(tmp_path / "outside.py", root / "engine" / "link.py")
    w = worker(root)
    w.ready()
    out = w.call("x", entry="engine/link.py:run")
    assert out["ok"] is False and out["error"]["code"] == "invalid_entry", out


def test_a_missing_function_or_file_is_refused(worker):
    w = worker()
    w.ready()
    out = w.call("echo", entry="engine/main.py:no_such_function")
    assert out["error"]["code"] == "invalid_entry"
    out = w.call("echo", entry="engine/no_such_file.py:run", req_id="r2")
    assert out["error"]["code"] == "invalid_entry"


def test_a_malformed_request_is_answered_and_the_worker_goes_on(worker):
    w = worker()
    w.ready()
    w.send_raw(b"{not json\n")
    out = w.next_message()
    assert out == {"type": "result", "id": None, "ok": False,
                   "error": {"code": "bad_request", "message": "The request is not a JSON object."}}
    w.send({"type": "teleport", "id": "q"})
    assert w.next_message()["error"]["code"] == "bad_request"
    assert w.call("echo", {"still": "alive"}, req_id="r3")["ok"] is True


def test_end_of_input_stops_the_worker(worker):
    w = worker()
    w.ready()
    w.proc.stdin.close()
    assert w.proc.wait(5) == 0


def test_shutdown_stops_the_worker(worker):
    w = worker()
    w.ready()
    w.send({"type": "shutdown"})
    assert w.proc.wait(5) == 0


def test_a_failing_bootstrap_exits_before_any_plugin_code(worker, tmp_path):
    root = _copy_echo(tmp_path)
    marker = tmp_path / "imported"
    (root / "engine" / "__init__.py").write_text(f"open({str(marker)!r}, 'w').close()\n")
    w = worker(root, mem_mb=0)
    msg = w.next_message()
    assert msg["type"] == "fatal" and msg["error"]["code"] == "worker_bootstrap_failed"
    assert w.proc.wait(5) == 70
    assert not marker.exists()


def test_a_missing_plugin_root_is_fatal(worker, tmp_path):
    w = worker(tmp_path / "nothing-here")
    msg = w.next_message()
    assert msg["type"] == "fatal"
    assert w.proc.wait(5) == 70


def test_the_temp_dir_is_private(worker):
    w = worker()
    w.ready()
    tmp = w.call("describe")["result"]["tmpdir"]
    mode = stat.S_IMODE(os.stat(tmp).st_mode)
    assert mode == 0o700
