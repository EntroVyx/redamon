"""Helpers for the plugin runner tests: a scripted HTTP server on 127.0.0.1 and the
shared Gateway contract cases. No test here touches a real network."""

from __future__ import annotations

import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional

from platform_version import PLATFORM_VERSION

RUNNER_ROOT = Path(__file__).resolve().parents[1]
SDK_ROOT = RUNNER_ROOT / "sdk"
CONTRACT_CASES = SDK_ROOT / "contract_cases.json"


def load_contract_cases() -> list[dict]:
    return json.loads(CONTRACT_CASES.read_text(encoding="utf-8"))["cases"]


class Recorded:
    def __init__(self, method: str, path: str, headers: dict, body: bytes):
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body

    def json(self):
        return json.loads(self.body.decode("utf-8")) if self.body else None


# reply(request) -> (status, headers, body bytes)
Reply = Callable[[Recorded], tuple]


class StubServer:
    """Records every request and answers from `reply`; `delay` stalls each answer."""

    def __init__(self):
        self.requests: list[Recorded] = []
        self.reply: Reply = lambda r: (200, {"Content-Type": "application/json"}, b"{}")
        self.delay = 0.0
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # keep test output clean
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                rec = Recorded(self.command, self.path,
                               {k.lower(): v for k, v in self.headers.items()}, body)
                stub.requests.append(rec)
                if stub.delay:
                    time.sleep(stub.delay)
                status, headers, payload = stub.reply(rec)
                try:
                    self.send_response(status)
                    for k, v in headers.items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = do_POST = do_PUT = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        # A short poll keeps shutdown() (one per test) from waiting the default 0.5 s.
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02},
                                       daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def answer_json(self, status: int, body) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.reply = lambda r: (status, {"Content-Type": "application/json"}, payload)

    def answer_raw(self, status: int, text: str, content_type: str = "text/html") -> None:
        payload = text.encode("utf-8")
        self.reply = lambda r: (status, {"Content-Type": content_type}, payload)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def free_port() -> int:
    """A port nothing listens on (bound then released)."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def resolve_call(sdk, call: dict):
    """The SDK coroutine a contract case names, e.g. "data.get" -> sdk.data.get(...)."""
    namespace, name = call["method"].split(".")
    fn = getattr(getattr(sdk, namespace), name)
    return fn(*call.get("args", []), **call.get("kwargs", {}))


def context_kwargs(case: dict) -> dict:
    ctx = case.get("context") or {}
    return {
        "project_id": ctx.get("projectId"),
        "session_id": ctx.get("sessionId"),
        "job_id": ctx.get("jobId"),
    }


def case_id(case: dict) -> Optional[str]:
    return case["name"]


# --- a worker driven over its real protocol --------------------------------------------

BOOTSTRAP = RUNNER_ROOT / "worker" / "bootstrap.py"
ECHO_ROOT = Path(__file__).resolve().parent / "fixtures" / "plugins" / "echo"
ECHO_MANIFEST = json.loads((ECHO_ROOT / "plugin.json").read_text(encoding="utf-8"))


def echo_entry(action: str) -> str:
    return next(a["entry"] for a in ECHO_MANIFEST["actions"] if a["id"] == action)


class WorkerProcess:
    """Starts worker/bootstrap.py as the supervisor does (`python -I -S`, protocol fd) and
    exchanges JSON lines with it synchronously. Messages from the protocol fd are queued by
    a reader thread; stderr is collected into `stderr_lines`."""

    def __init__(self, root: Path = ECHO_ROOT, *, mem_mb: int = 512, nproc: int = 64,
                 env: Optional[dict] = None, extra_args: Optional[list] = None):
        import os
        import queue
        import subprocess
        import sys

        r, w = os.pipe()
        self._queue: "queue.Queue" = queue.Queue()
        self.stderr_lines: list = []
        args = [sys.executable, "-I", "-S", str(BOOTSTRAP), "--root", str(root),
                "--sdk", str(SDK_ROOT), "--mem-mb", str(mem_mb), "--nproc", str(nproc),
                "--proto-fd", str(w)] + (extra_args or [])
        base_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
                    "PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0",
                    "REDAMON_GATEWAY_URL": "http://127.0.0.1:9"}
        base_env.update(env or {})
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, pass_fds=(w,), env=base_env, cwd="/")
        os.close(w)
        self._proto = os.fdopen(r, "rb")

        def read_proto():
            for line in self._proto:
                self._queue.put(json.loads(line))
            self._queue.put(None)

        def read_stream(stream, sink):
            for line in stream:
                sink.append(line.decode("utf-8", "replace").rstrip("\n"))

        self.stdout_lines: list = []
        for target, a in ((read_proto, ()), (read_stream, (self.proc.stderr, self.stderr_lines)),
                          (read_stream, (self.proc.stdout, self.stdout_lines))):
            threading.Thread(target=target, args=a, daemon=True).start()

    def send(self, msg: dict) -> None:
        self.proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def send_raw(self, raw: bytes) -> None:
        self.proc.stdin.write(raw)
        self.proc.stdin.flush()

    def next_message(self, timeout: float = 10.0):
        import queue
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError(f"no message from the worker within {timeout}s; stderr: {self.stderr_lines}")

    def ready(self, timeout: float = 10.0) -> dict:
        msg = self.next_message(timeout)
        assert msg and msg.get("type") == "ready", (msg, self.stderr_lines)
        return msg

    def invoke(self, action: str, params: Optional[dict] = None, *, req_id: str = "r1",
               entry: Optional[str] = None, ctx: Optional[dict] = None,
               token: str = "call-token") -> None:
        self.send({"type": "invoke", "id": req_id, "action": action,
                   "entry": entry or echo_entry(action), "params": params or {},
                   "ctx": ctx or {"pluginId": "echo", "version": "1.0.0", "userId": "user-1"},
                   "token": token})

    def call(self, action: str, params: Optional[dict] = None, timeout: float = 10.0, **kw) -> dict:
        self.invoke(action, params, **kw)
        return self.next_message(timeout)

    def close(self, timeout: float = 5.0) -> int:
        try:
            if self.proc.poll() is None:
                try:
                    self.send({"type": "shutdown"})
                except (BrokenPipeError, OSError):
                    pass
                try:
                    self.proc.wait(timeout)
                except Exception:
                    self.proc.kill()
                    self.proc.wait()
        finally:
            for s in (self.proc.stdin,):
                try:
                    s.close()
                except OSError:
                    pass
        return self.proc.returncode


# --- the supervisor under test ------------------------------------------------------------

RUNNER_KEY = "test-runner-key-0123456789abcdef"
IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0
# The gate runs test files in parallel processes, each with its own supervisor. A
# supervisor kills every process left under a UID it releases, so two of them must never
# hand out the same UIDs: each test process claims its own slice of the worker range, by
# a lock the kernel drops when the process ends (a pid-derived slice can collide).
_SLICE_LOCKS: list = []


def _claim_uid_slice() -> int:
    import fcntl
    for i in range(99):
        f = open(f"/tmp/redamon-test-uid-slice-{i}.lock", "a")
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            f.close()
            continue
        _SLICE_LOCKS.append(f)
        return 20000 + i * 100
    raise RuntimeError("every test UID slice is taken")


_SLICE = _claim_uid_slice()
TEST_UID_RANGE = (_SLICE, _SLICE + 99)


def make_plugins_dir() -> Path:
    """A plugins volume stand-in that worker UIDs can traverse and read: pytest's own
    tmp_path is 0700 and owned by the test user, so a worker under its own UID could not
    reach a plugin inside it."""
    import tempfile
    d = Path(tempfile.mkdtemp(prefix="plugins-", dir="/tmp"))
    d.chmod(0o755)
    return d


def install_plugin(plugins_dir: Path, plugin_id: str = "echo", version: str = "1.0.0", *,
                   manifest_changes: Optional[dict] = None, extra_files: Optional[dict] = None,
                   action_changes: Optional[dict] = None) -> dict:
    """Copies the echo fixture to <plugins>/<id>/versions/<v> and returns its run-list entry."""
    import shutil
    root = plugins_dir / plugin_id / "versions" / version
    shutil.copytree(ECHO_ROOT, root)
    for rel, text in (extra_files or {}).items():
        (root / rel).write_text(text)
    manifest = json.loads(json.dumps(ECHO_MANIFEST))
    manifest.update({"id": plugin_id, "version": version}, **(manifest_changes or {}))
    for action in manifest["actions"]:
        action.update((action_changes or {}).get(action["id"], {}))
    for p in [root, *root.rglob("*")]:
        p.chmod(0o755 if p.is_dir() else 0o644)
    for p in (plugins_dir / plugin_id, plugins_dir / plugin_id / "versions"):
        p.chmod(0o755)
    return {"id": plugin_id, "version": version, "manifest": manifest, "root": str(root)}


def run_list(entries: list, platform: str = PLATFORM_VERSION) -> dict:
    return {"platformVersion": platform, "plugins": entries}


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie still answers kill(0); check its state.
    try:
        with open(f"/proc/{pid}/status") as f:
            return "\nState:\tZ" not in f.read()
    except OSError:
        return False


def wait_until(predicate, timeout: float = 10.0, interval: float = 0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError(f"condition not met within {timeout}s")
