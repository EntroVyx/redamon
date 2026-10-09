"""Isolation of a worker started by the supervisor (TD-04, D-17, R-59): its own UID,
limits that hold, a plugin root it cannot write, and no way for another process under the
same UID to read its memory or environment. Spawning under another UID needs root, as in
the runner image; elsewhere these tests skip."""

import ast
import errno
import subprocess
import sys

import pytest

from tests.support import IS_ROOT, RUNNER_ROOT, TEST_UID_RANGE, install_plugin, wait_until

root_only = pytest.mark.skipif(not IS_ROOT, reason="workers get their own UID only when the supervisor runs as root")

PROBES = '''
import os
import time


async def allocate(ctx, params):
    try:
        block = bytearray(int(params.get("mb", 1024)) * 1024 * 1024)
    except MemoryError:
        return {"allocated": False}
    return {"allocated": True, "size": len(block)}


async def fork_loop(ctx, params):
    children, error = [], None
    for _ in range(int(params.get("max", 500))):
        try:
            pid = os.fork()
        except OSError as e:
            error = e.errno
            break
        if pid == 0:
            time.sleep(1.0)
            os._exit(0)
        children.append(pid)
    for pid in children:
        os.waitpid(pid, 0)
    return {"forked": len(children), "errno": error}


async def write_file(ctx, params):
    try:
        with open(params["path"], "w") as f:
            f.write("x")
    except OSError as e:
        return {"written": False, "errno": e.errno}
    return {"written": True}


async def read_file(ctx, params):
    try:
        with open(params["path"], "rb") as f:
            return {"read": True, "size": len(f.read())}
    except OSError as e:
        return {"read": False, "errno": e.errno}
'''

PROBE_ACTIONS = [{"id": name, "entry": f"engine/probes.py:{name}", "timeoutSeconds": 30}
                 for name in ("allocate", "fork_loop", "write_file", "read_file")]


def _with_probes(plugins_dir, plugin_id="echo"):
    entry = install_plugin(plugins_dir, plugin_id, extra_files={"engine/probes.py": PROBES})
    entry["manifest"]["actions"].extend(PROBE_ACTIONS)
    return entry


def test_spawn_never_uses_preexec_fn():
    """preexec_fn is unsafe in a process with threads, and the supervisor has them (RV-09)."""
    source = (RUNNER_ROOT / "supervisor" / "spawn.py").read_text()
    tree = ast.parse(source)
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    keywords = {k.arg for n in ast.walk(tree) if isinstance(n, ast.Call) for k in n.keywords}
    assert "preexec_fn" not in names | keywords
    assert "preexec_fn" not in source


@root_only
def test_the_worker_runs_under_its_own_uid_with_no_groups(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    w = h.health()["workers"][0]
    d = h.act("echo", "describe").json()["result"]
    assert 20000 <= d["uid"] <= 29999 and d["uid"] in range(TEST_UID_RANGE[0], TEST_UID_RANGE[1] + 1)
    assert d["uid"] == d["euid"] == d["gid"] == w["uid"]
    assert d["groups"] == []
    assert d["pgid"] == d["pid"]


@root_only
def test_two_workers_never_share_a_uid(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir), install_plugin(plugins_dir, "echo-two")])
    uids = [w["uid"] for w in h.health()["workers"]]
    assert len(set(uids)) == 2


@root_only
def test_the_memory_limit_stops_a_large_allocation(runner, plugins_dir):
    h = runner([_with_probes(plugins_dir)], worker_mem_mb=512)
    assert h.act("echo", "allocate", {"mb": 1024}).json()["result"] == {"allocated": False}
    assert h.act("echo", "allocate", {"mb": 16}).json()["result"]["allocated"] is True


@root_only
def test_the_process_limit_stops_a_fork_loop(runner, plugins_dir):
    h = runner([_with_probes(plugins_dir)], worker_nproc=16)
    out = h.act("echo", "fork_loop", {"max": 200}).json()["result"]
    assert out["errno"] == errno.EAGAIN
    assert out["forked"] < 16


@root_only
def test_the_plugin_root_is_not_writable(runner, plugins_dir):
    entry = _with_probes(plugins_dir)
    h = runner([entry])
    for path in (f"{entry['root']}/plugin.json", f"{entry['root']}/new-file", f"{entry['root']}/engine/x.py"):
        out = h.act("echo", "write_file", {"path": path}).json()["result"]
        assert out == {"written": False, "errno": errno.EACCES}, path


@root_only
def test_the_worker_is_not_dumpable(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    w = h.health()["workers"][0]
    assert h.act("echo", "describe").json()["result"]["dumpable"] == 0
    import os
    # An undumpable process's /proc entries belong to root, not to its own UID.
    assert os.stat(f"/proc/{w['pid']}/environ").st_uid == 0
    peer = subprocess.run([sys.executable, "-I", "-c", f"open('/proc/{w['pid']}/environ', 'rb').read()"],
                          user=w["uid"], group=w["uid"], extra_groups=[], capture_output=True, text=True)
    assert peer.returncode != 0 and "PermissionError" in peer.stderr


@root_only
def test_a_worker_cannot_read_another_worker_or_pid_1(runner, plugins_dir):
    h = runner([_with_probes(plugins_dir), install_plugin(plugins_dir, "echo-two")])
    other = h.workers()["echo-two@1.0.0"]
    for path in (f"/proc/{other['pid']}/environ", "/proc/1/environ"):
        out = h.act("echo", "read_file", {"path": path}).json()["result"]
        assert out == {"read": False, "errno": errno.EACCES}, path


@root_only
def test_the_temp_dir_is_the_workers_own(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    d = h.act("echo", "describe").json()["result"]
    assert d["tmpMode"] == 0o700 and d["tmpOwner"] == d["uid"]


@root_only
def test_a_uid_is_released_when_its_worker_goes(runner, plugins_dir):
    from tests.support import run_list
    h = runner([install_plugin(plugins_dir)])
    uid = h.health()["workers"][0]["uid"]
    h.run_list = run_list([])
    h.reload()
    h.run_list = run_list([install_plugin(plugins_dir, version="1.0.1")])
    h.reload()
    wait_until(lambda: h.health()["workers"])
    assert h.health()["workers"][0]["uid"] == uid
