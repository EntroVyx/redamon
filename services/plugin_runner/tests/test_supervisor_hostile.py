"""Plugin code that misbehaves, on purpose or by accident, against the supervisor (found by
the phase 03 review in a replica of the production container): a daemon that escapes its
process group and keeps the worker's pipes open, a worker that stops reading, garbage on
the protocol pipe, a stderr line longer than any buffer, files and IPC objects left behind
under a UID that a different plugin receives next, and a plugin listening on the API port."""

import os
import socket
import time

import pytest

from tests.support import IS_ROOT, TEST_UID_RANGE, install_plugin, pid_alive, run_list, wait_until

root_only = pytest.mark.skipif(not IS_ROOT, reason="workers get their own UID only when the supervisor runs as root")

HOSTILE = '''
import ctypes
import os
import signal
import sys
import time


async def daemon(ctx, params):
    """Leaves a grandchild in its own session, holding every fd the worker had."""
    r, w = os.pipe()
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            os.write(w, str(os.getpid()).encode())
            time.sleep(600)
            os._exit(0)
        os._exit(0)
    os.wait()
    return {"pid": int(os.read(r, 32))}


async def long_line(ctx, params):
    sys.stderr.write("L" * int(params.get("bytes", 200000)))
    sys.stderr.flush()
    for i in range(int(params.get("after", 3000))):
        print(f"line {i} after the long one")
    return {"done": True}


async def leave_files(ctx, params):
    paths = [os.path.join(os.environ["TMPDIR"], "secret.txt"), f"/tmp/left-{os.getuid()}.txt"]
    if os.path.isdir("/dev/shm") and os.access("/dev/shm", os.W_OK):
        paths.append(f"/dev/shm/left-{os.getuid()}.txt")
    for p in paths:
        with open(p, "w") as f:
            f.write(params["secret"])
        os.chmod(p, 0o600)
    # IPC_PRIVATE, IPC_CREAT | 0600: a SysV segment outlives the process that made it.
    shm = ctypes.CDLL(None, use_errno=True).shmget(0, 4096, 0o1600)
    return {"paths": paths, "shm": shm}


async def write_plain(ctx, params):
    path = f"/tmp/plain-{os.getpid()}.txt"
    with open(path, "w") as f:
        f.write("written with the default mode")
    return {"path": path}


async def freeze(ctx, params):
    """Stops the whole worker: it reads no request and answers nothing any more."""
    os.kill(os.getpid(), signal.SIGSTOP)
    return {}


async def garbage(ctx, params):
    fd = int(sys.argv[sys.argv.index("--proto-fd") + 1])
    os.write(fd, params["line"].encode() + b"\\n")
    return {"sent": True}


async def hunt(ctx, params):
    found = {}
    for root in ("/tmp", "/dev/shm"):
        for dirpath, _, files in os.walk(root):
            for fn in files:
                p = os.path.join(dirpath, fn)
                try:
                    with open(p, errors="replace") as f:
                        data = f.read(200)
                except OSError:
                    continue
                if params["secret"] in data:
                    found[p] = data
    return {"found": found}
'''

ACTIONS = [{"id": a, "entry": f"engine/hostile.py:{a}", "timeoutSeconds": 60}
           for a in ("daemon", "long_line", "leave_files", "hunt", "freeze", "garbage", "write_plain")]


def _hostile(plugins_dir, plugin_id="echo"):
    entry = install_plugin(plugins_dir, plugin_id, extra_files={"engine/hostile.py": HOSTILE})
    entry["manifest"]["actions"].extend(ACTIONS)
    return entry


def _ctx(plugin_id):
    return {"pluginId": plugin_id, "version": "1.0.0", "userId": "u"}


def _proc_state(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            return next(line.split()[1] for line in f if line.startswith("State:"))
    except (OSError, StopIteration):
        return None


def _shm_ids():
    with open("/proc/sysvipc/shm") as f:
        return {line.split()[1] for line in f.readlines()[1:]}


def test_a_crash_is_noticed_even_when_a_daemon_holds_the_workers_pipes(runner, plugins_dir):
    h = runner([_hostile(plugins_dir)])
    before = h.health()["workers"][0]
    daemon = h.act("echo", "daemon").json()["result"]["pid"]
    started = time.time()
    r = h.act("echo", "crash", timeout=30)
    assert r.status_code == 502 and r.json()["code"] == "worker_crashed", r.text
    assert time.time() - started < 15
    wait_until(lambda: h.restarted_from(before["pid"]), timeout=45)
    assert h.act("echo", "echo").json()["ok"] is True
    if IS_ROOT:
        # Everything under the crashed worker's UID went with it.
        wait_until(lambda: not pid_alive(daemon), timeout=10)


@root_only
def test_a_timeout_kill_reaches_a_daemon_outside_the_process_group(runner, plugins_dir):
    h = runner([_hostile(plugins_dir)])
    before = h.health()["workers"][0]
    daemon = h.act("echo", "daemon").json()["result"]["pid"]
    assert h.act("echo", "sleep", {"seconds": 60}, timeout=1).status_code == 504
    wait_until(lambda: h.restarted_from(before["pid"]), timeout=45)
    wait_until(lambda: not pid_alive(daemon), timeout=10)


@root_only
def test_stopping_a_worker_leaves_nothing_running_under_its_uid(runner, plugins_dir):
    h = runner([_hostile(plugins_dir)])
    uid = h.health()["workers"][0]["uid"]
    daemon = h.act("echo", "daemon").json()["result"]["pid"]
    h.run_list = run_list([])
    started = time.time()
    h.reload()
    assert time.time() - started < 20
    wait_until(lambda: not pid_alive(daemon), timeout=10)
    # Zombies aside: reaping orphans is PID 1's job (compose `init: true`), and the test
    # container's PID 1 may not do it.
    owners = []
    for name in os.listdir("/proc"):
        if name.isdigit() and _proc_state(name) not in (None, "Z", "X"):
            try:
                with open(f"/proc/{name}/status") as f:
                    owners += [line.split()[1] for line in f if line.startswith("Uid:")]
            except OSError:
                pass
    assert str(uid) not in owners


def test_a_worker_that_stops_reading_cannot_hold_a_call_past_its_timeout(runner, plugins_dir):
    h = runner([_hostile(plugins_dir)])
    before = h.health()["workers"][0]
    assert h.act("echo", "freeze", async_=True, job_id="freeze", timeout=40).status_code == 202
    wait_until(lambda: _proc_state(before["pid"]) == "T", timeout=10)
    started = time.time()
    # More than the pipe and the write buffer hold: the send itself waits on the worker.
    r = h.act("echo", "echo", {"blob": "x" * 1_000_000}, timeout=3)
    assert r.status_code == 504 and r.json()["code"] == "action_timeout", r.text
    assert time.time() - started < 10
    wait_until(lambda: h.restarted_from(before["pid"]), timeout=45)


def test_disabling_a_worker_that_stopped_reading_does_not_hang_the_reload(runner, plugins_dir):
    h = runner([_hostile(plugins_dir)])
    pid = h.health()["workers"][0]["pid"]
    assert h.act("echo", "freeze", async_=True, job_id="freeze", timeout=40).status_code == 202
    wait_until(lambda: _proc_state(pid) == "T", timeout=10)
    assert h.act("echo", "echo", {"blob": "x" * 1_000_000}, async_=True, job_id="big", timeout=40).status_code == 202
    h.run_list = run_list([])
    started = time.time()
    h.reload()
    assert time.time() - started < 15
    wait_until(lambda: not pid_alive(pid), timeout=10)


@pytest.mark.parametrize("line", ['{"type":"result","id":[]}', "[" * 100_000],
                         ids=["unhashable-id", "nested-too-deep"])
def test_protocol_garbage_kills_the_worker_instead_of_stopping_the_reader(runner, plugins_dir, line):
    h = runner([_hostile(plugins_dir)])
    before = h.health()["workers"][0]
    started = time.time()
    r = h.act("echo", "garbage", {"line": line}, timeout=20)
    assert r.status_code == 502 and r.json()["code"] == "worker_restarted", r.text
    assert time.time() - started < 10
    wait_until(lambda: h.restarted_from(before["pid"]), timeout=45)
    assert h.act("echo", "echo").json()["ok"] is True


def test_a_stderr_line_longer_than_any_buffer_does_not_wedge_the_worker(runner, plugins_dir):
    h = runner([_hostile(plugins_dir)])
    started = time.time()
    # The long line and what follows fit in the 1,000-line buffer the logs route reads.
    r = h.act("echo", "long_line", {"bytes": 200_000, "after": 500}, timeout=30)
    assert r.status_code == 200 and r.json() == {"ok": True, "result": {"done": True}}, r.text
    assert time.time() - started < 20
    assert h.act("echo", "echo").json()["ok"] is True

    def logged():
        lines = h.get("/runner/v1/plugins/echo/logs?lines=1000").json()["lines"]
        return any("line 499 after the long one" in line for line in lines) and lines
    lines = wait_until(logged, timeout=20)
    long = [line for line in lines if line.count("L") > 1000]
    assert long and all(len(line) <= 4100 for line in long)


@root_only
def test_a_reused_uid_carries_no_file_of_the_previous_plugin(runner, plugins_dir):
    # One UID only: the second plugin must receive exactly the UID the first one had.
    one = (TEST_UID_RANGE[0], TEST_UID_RANGE[0])
    h = runner([_hostile(plugins_dir, "plugin-a")], uid_range=one)
    a = h.workers()["plugin-a@1.0.0"]
    secret = "SECRET-OF-PLUGIN-A-%d" % os.getpid()
    result = h.act("plugin-a", "leave_files", {"secret": secret}, ctx=_ctx("plugin-a")).json()["result"]
    left, shm = result["paths"], str(result["shm"])
    assert len(left) >= 2 and shm in _shm_ids()
    h.run_list = run_list([])
    h.reload()
    # Gone when the UID is released, not only when it is handed out again.
    for p in left:
        assert not os.path.exists(p), p
    assert shm not in _shm_ids()
    h.run_list = run_list([_hostile(plugins_dir, "plugin-b")])
    h.reload()
    b = h.workers()["plugin-b@1.0.0"]
    assert b["uid"] == a["uid"]
    found = h.act("plugin-b", "hunt", {"secret": secret}, ctx=_ctx("plugin-b")).json()["result"]["found"]
    assert found == {}


@root_only
def test_a_restarted_worker_finds_nothing_its_crashed_predecessor_left(runner, plugins_dir):
    h = runner([_hostile(plugins_dir)])
    before = h.health()["workers"][0]
    result = h.act("echo", "leave_files", {"secret": "s"}).json()["result"]
    assert h.act("echo", "crash").status_code == 502
    wait_until(lambda: h.restarted_from(before["pid"]), timeout=45)
    for p in result["paths"]:
        assert not os.path.exists(p), p
    assert str(result["shm"]) not in _shm_ids()


def test_files_a_worker_writes_in_the_shared_tmp_are_its_own_only(runner, plugins_dir):
    h = runner([_hostile(plugins_dir)])
    path = h.act("echo", "write_plain").json()["result"]["path"]
    try:
        assert os.stat(path).st_mode & 0o077 == 0, oct(os.stat(path).st_mode)
    finally:
        if os.path.exists(path):
            os.unlink(path)


@root_only
def test_a_reload_that_cannot_start_a_worker_still_stops_the_removed_ones(runner, plugins_dir):
    one = (TEST_UID_RANGE[0], TEST_UID_RANGE[0])
    h = runner([_hostile(plugins_dir, "plugin-a")], uid_range=one)
    a = h.workers()["plugin-a@1.0.0"]
    # plugin-b needs a UID while plugin-a still holds the only one.
    h.run_list = run_list([_hostile(plugins_dir, "plugin-b")])
    h.reload()
    assert not pid_alive(a["pid"])
    assert "plugin-b@1.0.0" not in h.workers()
    h.reload()
    assert h.workers()["plugin-b@1.0.0"]["state"] == "ready"


@root_only
def test_uids_are_handed_out_round_robin(runner, plugins_dir):
    h = runner([_hostile(plugins_dir, "plugin-a")])
    first = h.workers()["plugin-a@1.0.0"]["uid"]
    h.run_list = run_list([])
    h.reload()
    h.run_list = run_list([_hostile(plugins_dir, "plugin-b")])
    h.reload()
    assert h.workers()["plugin-b@1.0.0"]["uid"] == first + 1


def test_the_api_port_listens_before_the_lifespan_starts_any_worker(monkeypatch):
    import uvicorn
    from supervisor import app as app_module

    seen = {}

    def run(server, sockets=None):
        seen["listening"] = [s.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) for s in sockets]
        for s in sockets:
            s.close()

    monkeypatch.setattr(uvicorn.Server, "run", run)
    monkeypatch.setattr(app_module, "DEFAULT_PORT", 0)
    monkeypatch.setenv("PLUGIN_RUNNER_KEY", "")
    app_module.main()
    assert seen["listening"] == [1]


def test_a_plugin_cannot_bind_the_api_port_once_it_listens():
    from supervisor.app import listening_socket

    sock = listening_socket(0)
    port = sock.getsockname()[1]
    try:
        for host in ("0.0.0.0", "127.0.0.1"):
            other = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            other.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            with pytest.raises(OSError):
                other.bind((host, port))
            other.close()
    finally:
        sock.close()
