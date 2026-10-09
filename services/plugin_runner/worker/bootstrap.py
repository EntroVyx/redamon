"""A plugin worker: one process per (plugin, version), started by the supervisor as

    python -I -S worker/bootstrap.py --root <plugin version dir> --sdk <sdk dir>
        --mem-mb N --nproc N --proto-fd N

under its own UID with a clean environment (supervisor/spawn.py). Before it loads any
plugin code it lowers its own limits, makes itself undumpable, lowers its priority and
creates its private temp directory; a failure there ends it with exit code 70 and a
`fatal` line. Then it serves requests:

    stdin (JSON lines)   {type: invoke, id, action, entry, params, ctx, token}
                         {type: cancel, id}        {type: shutdown}
    --proto-fd           {type: ready, pid}
                         {type: result, id, ok: true, result}
                         {type: result, id, ok: false, error: {code, message}}

Plugin output (print, fd 1) goes to stderr, which the supervisor keeps as the plugin's
log; it never reaches the protocol. This file is never imported by the supervisor and
imports nothing from it: only the standard library, then the SDK and the plugin.
"""

import argparse
import asyncio
import ctypes
import importlib
import inspect
import json
import os
import queue
import re
import resource
import sys
import tempfile
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

EXIT_BOOTSTRAP_FAILED = 70
MIB = 1024 * 1024
NOFILE_LIMIT = 256
FSIZE_LIMIT = 64 * MIB
RESULT_MAX_BYTES = 2 * MIB
MESSAGE_MAX_CHARS = 2000
# Threads count against RLIMIT_NPROC and each glibc malloc arena reserves 64 MB of
# address space against RLIMIT_AS, so both are kept small.
EXECUTOR_THREADS = 8
MALLOC_ARENAS = 2
PR_SET_DUMPABLE = 4
M_ARENA_MAX = -8
# The manifest's own rule (webapp/src/lib/plugins/schemas/manifest.ts ENTRY_RE).
ENTRY_RE = re.compile(r"^(engine(?:/[a-z0-9_]+)+)\.py:([a-z_][a-z0-9_]*)$")
CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
GENERIC_ERROR = ("internal_plugin_error", "The plugin failed. Details are in its log.")


class EntryError(Exception):
    pass


class RequestError(Exception):
    pass


class Protocol:
    """Writes answers to the protocol fd from one thread, so a large result never blocks
    the event loop while the supervisor drains the pipe."""

    def __init__(self, fd: int):
        os.set_inheritable(fd, False)
        self._fd = fd
        self._queue: "queue.Queue" = queue.Queue()
        self._thread = threading.Thread(target=self._drain, name="protocol-writer", daemon=True)
        self._thread.start()

    def _drain(self) -> None:
        while True:
            data = self._queue.get()
            if data is None:
                return
            view = memoryview(data)
            while view:
                view = view[os.write(self._fd, view):]

    def send_bytes(self, data: bytes) -> None:
        self._queue.put(data)

    def send(self, msg: dict) -> None:
        self.send_bytes(json.dumps(msg, separators=(",", ":")).encode("utf-8") + b"\n")

    def close(self) -> None:
        self._queue.put(None)
        self._thread.join(5)


def _parse_args(argv):
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--root", required=True)
    p.add_argument("--sdk", required=True)
    p.add_argument("--mem-mb", type=int, required=True)
    p.add_argument("--nproc", type=int, required=True)
    p.add_argument("--proto-fd", type=int, required=True)
    return p.parse_args(argv)


def _lower(limit: int, value: int) -> None:
    _, hard = resource.getrlimit(limit)
    if hard != resource.RLIM_INFINITY:
        value = min(value, hard)
    resource.setrlimit(limit, (value, value))


def _harden(args) -> str:
    """Everything that must hold before plugin code runs. Raises on any failure."""
    if not 64 <= args.mem_mb <= 1024 * 1024:
        raise ValueError(f"--mem-mb {args.mem_mb} is outside 64..1048576")
    if not 8 <= args.nproc <= 4096:
        raise ValueError(f"--nproc {args.nproc} is outside 8..4096")
    _lower(resource.RLIMIT_AS, args.mem_mb * MIB)
    _lower(resource.RLIMIT_NPROC, args.nproc)
    _lower(resource.RLIMIT_NOFILE, NOFILE_LIMIT)
    _lower(resource.RLIMIT_CORE, 0)
    _lower(resource.RLIMIT_FSIZE, FSIZE_LIMIT)
    libc = ctypes.CDLL(None, use_errno=True)
    # Not dumpable: another worker, even under the same UID, cannot read this process's
    # memory or /proc/<pid>/environ (experiment E2, probe 8).
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE, 0) failed")
    libc.mallopt(M_ARENA_MAX, MALLOC_ARENAS)
    # No unprivileged per-process CPU cap exists; the container's `cpus:` is the hard bound.
    os.nice(10)
    # Created by the worker itself, so it is 0700 and its own without CAP_CHOWN.
    tmp = tempfile.mkdtemp(prefix="plugin-", dir="/tmp")
    os.environ["HOME"] = tmp
    os.environ["TMPDIR"] = tmp
    tempfile.tempdir = tmp
    os.chdir(tmp)
    return tmp


class Worker:
    def __init__(self, root: str, proto: Protocol, gateway_url: str):
        self.root = root
        self.engine_dir = os.path.join(root, "engine")
        self.proto = proto
        self.gateway_url = gateway_url
        self.tasks: dict = {}
        from redamon_plugin_sdk import Context, GatewayTransport, PluginError, Sdk
        self._sdk = (Context, GatewayTransport, PluginError, Sdk)

    # -- answers ---------------------------------------------------------------

    def _error(self, rid, code: str, message: str) -> None:
        self.proto.send({"type": "result", "id": rid, "ok": False,
                         "error": {"code": code, "message": message}})

    def _result(self, rid, result) -> None:
        if not isinstance(result, dict):
            return self._error(rid, "invalid_result", "The plugin returned something that is not a JSON object.")
        try:
            body = json.dumps(result, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError):
            return self._error(rid, "invalid_result", "The plugin's result cannot be sent as JSON.")
        if len(body) > RESULT_MAX_BYTES:
            return self._error(rid, "result_too_large",
                               f"The plugin's result is {len(body)} bytes; the limit is {RESULT_MAX_BYTES}.")
        head = json.dumps({"type": "result", "id": rid, "ok": True}, separators=(",", ":"))
        self.proto.send_bytes(head[:-1].encode("utf-8") + b',"result":' + body + b"}\n")

    # -- requests --------------------------------------------------------------

    def resolve(self, entry):
        m = ENTRY_RE.match(entry) if isinstance(entry, str) else None
        if not m:
            raise EntryError(f"The entry {entry!r} is not engine/<path>.py:<function>.")
        rel, func = m.group(1), m.group(2)
        engine = os.path.realpath(self.engine_dir)
        path = os.path.realpath(os.path.join(self.root, rel + ".py"))
        if not engine.startswith(self.root + os.sep) or not path.startswith(engine + os.sep):
            raise EntryError(f"The entry {entry!r} resolves outside the plugin's engine folder.")
        if not os.path.isfile(path):
            raise EntryError(f"The entry {entry!r} names a file that does not exist.")
        module = importlib.import_module(rel.replace("/", "."))
        if os.path.realpath(getattr(module, "__file__", None) or "") != path:
            raise EntryError(f"The entry {entry!r} was loaded from another file.")
        fn = getattr(module, func, None)
        if fn is None:
            raise EntryError(f"The entry {entry!r} names a function that does not exist.")
        if not inspect.iscoroutinefunction(fn):
            raise EntryError(f"The entry {entry!r} must be an `async def` function.")
        return fn

    def context(self, msg: dict):
        Context, GatewayTransport, _, Sdk = self._sdk
        c = msg.get("ctx")
        if not isinstance(c, dict) or not all(isinstance(c.get(k), str) for k in ("pluginId", "version", "userId")):
            raise RequestError("The request has no valid context.")
        try:
            transport = GatewayTransport(self.gateway_url, msg.get("token"))
        except ValueError:
            raise RequestError("The request has no call token.") from None

        def opt(key):
            v = c.get(key)
            return v if isinstance(v, str) and v else None

        return Context(plugin_id=c["pluginId"], version=c["version"], user_id=c["userId"],
                       project_id=opt("projectId"), session_id=opt("sessionId"),
                       conversation_id=opt("conversationId"), job_id=opt("jobId"),
                       sdk=Sdk(transport, job_id=opt("jobId")))

    async def run(self, rid: str, msg: dict) -> None:
        PluginError = self._sdk[2]
        params = msg.get("params")
        try:
            if not isinstance(params, dict):
                raise RequestError("params must be a JSON object.")
            ctx = self.context(msg)
            fn = self.resolve(msg.get("entry"))
        except EntryError as e:
            return self._error(rid, "invalid_entry", str(e))
        except RequestError as e:
            return self._error(rid, "bad_request", str(e))
        except Exception:
            traceback.print_exc()
            return self._error(rid, *GENERIC_ERROR)
        try:
            result = await fn(ctx, params)
        except asyncio.CancelledError:
            return self._error(rid, "cancelled", "The action was cancelled.")
        except PluginError as e:
            code = e.code if isinstance(e.code, str) and CODE_RE.match(e.code) else "plugin_error"
            return self._error(rid, code, str(e.message)[:MESSAGE_MAX_CHARS])
        except Exception:
            traceback.print_exc()
            return self._error(rid, *GENERIC_ERROR)
        self._result(rid, result)

    async def serve(self, req_fd: int) -> None:
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=EXECUTOR_THREADS,
                                                     thread_name_prefix="plugin-io"))
        inbox: asyncio.Queue = asyncio.Queue()

        def read_requests():
            with os.fdopen(req_fd, "rb") as f:
                for line in f:
                    loop.call_soon_threadsafe(inbox.put_nowait, line)
            loop.call_soon_threadsafe(inbox.put_nowait, None)

        threading.Thread(target=read_requests, name="request-reader", daemon=True).start()
        self.proto.send({"type": "ready", "pid": os.getpid()})
        while True:
            line = await inbox.get()
            if line is None:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                msg = None
            if not isinstance(msg, dict):
                self._error(None, "bad_request", "The request is not a JSON object.")
                continue
            kind, rid = msg.get("type"), msg.get("id")
            if kind == "shutdown":
                break
            if kind == "cancel":
                task = self.tasks.get(rid)
                if task is not None:
                    task.cancel()
                continue
            if kind != "invoke":
                self._error(rid if isinstance(rid, str) else None, "bad_request", "Unknown request type.")
                continue
            if not isinstance(rid, str) or not rid or rid in self.tasks:
                self._error(rid if isinstance(rid, str) else None, "bad_request",
                            "An invoke needs a request id that is not in use.")
                continue
            task = asyncio.create_task(self.run(rid, msg))
            self.tasks[rid] = task
            task.add_done_callback(lambda _t, rid=rid: self.tasks.pop(rid, None))
        for task in list(self.tasks.values()):
            task.cancel()
        if self.tasks:
            await asyncio.wait(list(self.tasks.values()), timeout=2)


def main(argv) -> None:
    args = _parse_args(argv)
    try:
        proto = Protocol(args.proto_fd)
    except OSError as e:
        sys.stderr.write(f"worker: protocol fd {args.proto_fd} unusable: {e}\n")
        os._exit(EXIT_BOOTSTRAP_FAILED)

    def fatal(exc: BaseException) -> None:
        proto.send({"type": "fatal", "error": {"code": "worker_bootstrap_failed",
                                               "message": f"{type(exc).__name__}: {exc}"}})
        proto.close()
        sys.stderr.write(f"worker: bootstrap failed: {type(exc).__name__}: {exc}\n")
        sys.stderr.flush()
        os._exit(EXIT_BOOTSTRAP_FAILED)

    try:
        _harden(args)
        root = os.path.realpath(args.root)
        sdk = os.path.realpath(args.sdk)
        for d, what in ((root, "plugin root"), (sdk, "SDK")):
            if not os.path.isdir(d):
                raise FileNotFoundError(f"the {what} {d} is not a directory")
        gateway_url = os.environ.get("REDAMON_GATEWAY_URL", "")
        if not gateway_url.startswith(("http://", "https://")):
            raise ValueError("REDAMON_GATEWAY_URL is not set")
        stdlib = [p for p in sys.path if "site-packages" not in p and "dist-packages" not in p]
        sys.path[:] = [sdk, root, os.path.join(root, "vendor")] + stdlib
        # Requests keep a private fd; fd 0 becomes /dev/null so plugin code reading stdin
        # cannot consume them. Plugin output on fd 1 joins stderr, the plugin's log.
        req_fd = os.dup(0)
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
        os.dup2(2, 1)
        sys.stdin = open(os.devnull, "r")
        sys.stdout = sys.stderr
        worker = Worker(root, proto, gateway_url)
    except Exception as e:
        fatal(e)
        return
    asyncio.run(worker.serve(req_fd))
    proto.close()
    sys.stderr.flush()
    # Not sys.exit: a thread still waiting on a Gateway call would hold the interpreter.
    os._exit(0)


if __name__ == "__main__":
    main(sys.argv[1:])
