"""Worker processes: one per (plugin, version), started, called, restarted and stopped.

A worker is untrusted code. Everything it sends is checked, a timeout or a protocol
violation kills its whole process group, and when it goes every process still running
under its UID is killed too (a plugin may fork and leave its group), so a UID is never
handed to the next worker while something of the previous one lives.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import signal
import uuid
from typing import Callable, Optional

from .spawn import spawn

CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MESSAGE_MAX_CHARS = 2000
STOP_WAIT_SECONDS = 3.0
# A worker that keeps crashing is restarted ever more slowly, up to this.
RESTART_BACKOFF_MAX = 30.0


class RunnerError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _clean_error(error) -> dict:
    if not isinstance(error, dict):
        return {"code": "plugin_error", "message": "The plugin failed."}
    code = error.get("code")
    message = error.get("message")
    return {"code": code if isinstance(code, str) and CODE_RE.match(code) else "plugin_error",
            "message": str(message)[:MESSAGE_MAX_CHARS] if message is not None else "The plugin failed."}


def kill_uid_processes(uid: Optional[int]) -> int:
    """Kills every process whose real or effective UID is `uid`. Only worker UIDs."""
    if uid is None or uid < 20000:
        return 0
    killed = 0
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/status") as f:
                uids = next(line.split()[1:3] for line in f if line.startswith("Uid:"))
        except (OSError, StopIteration):
            continue
        if str(uid) in uids:
            try:
                os.kill(int(name), signal.SIGKILL)
                killed += 1
            except OSError:
                pass
    return killed


class WorkerHandle:
    """One (plugin, version): its current process, in-flight calls and restart count."""

    def __init__(self, *, settings, logs, clock, entry, uid: Optional[int],
                 should_run: Callable[["WorkerHandle"], bool], release_uid: Callable[[Optional[int]], None]):
        self.settings = settings
        self.logs = logs
        self.clock = clock
        self.entry = entry
        self.plugin_id = entry.plugin_id
        self.version = entry.version
        self.uid = uid
        self._should_run = should_run
        self._release_uid = release_uid
        self.proc = None
        self.pid: Optional[int] = None
        self.state = "starting"
        self.started_at: Optional[str] = None
        self.restarts = 0
        self.last_error: Optional[str] = None
        self.pending: dict = {}
        self.jobs: dict = {}
        self._cancelled: set = set()
        self._kill_reason: Optional[str] = None
        self._stopping = False
        self._tasks: set = set()
        self._restart_task: Optional[asyncio.Task] = None
        self._recent_crashes = 0

    # -- lifecycle -------------------------------------------------------------

    @property
    def actions(self) -> dict:
        return self.entry.actions

    def describe(self) -> dict:
        return {"id": self.plugin_id, "version": self.version, "pid": self.pid, "uid": self.uid,
                "inFlight": len(self.pending), "startedAt": self.started_at, "restarts": self.restarts,
                "state": self.state}

    def _event(self, message: str) -> None:
        self.logs.event(self.plugin_id, self.version, message)

    def _task(self, coro) -> asyncio.Task:
        t = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        return t

    async def start(self) -> bool:
        """Starts a process and waits for its `ready`. False (state `failed`) when it cannot."""
        self.state = "starting"
        self._kill_reason = None
        loop = asyncio.get_running_loop()
        ready = loop.create_future()
        # A start that gave up waiting leaves this future to fail later, unawaited.
        ready.add_done_callback(lambda f: f.cancelled() or f.exception())
        try:
            self.proc, reader = await spawn(self.settings, self.entry.root, self.uid)
        except OSError as e:
            self.state = "failed"
            self.last_error = f"could not start the worker: {e}"
            self._event(self.last_error)
            return False
        self.pid = self.proc.pid
        if self._stopping:
            self._kill("stopped")
            return False
        self._task(self._pump_stderr(self.proc))
        self._task(self._pump_protocol(self.proc, reader, ready))
        try:
            msg = await asyncio.wait_for(asyncio.shield(ready), self.settings.ready_timeout)
        except (asyncio.TimeoutError, RuntimeError) as e:
            self.state = "failed"
            self.last_error = str(e) or "the worker did not start in time"
            self._event(f"worker failed to start: {self.last_error}")
            self._kill("failed_start")
            return False
        self.state = "ready"
        self.started_at = self.clock.now_iso()
        self._event(f"worker started: pid {msg.get('pid')} uid {self.uid}")
        return True

    async def stop(self) -> None:
        self._stopping = True
        self.state = "stopping"
        # A restart in progress would otherwise start a process nobody stops.
        restart = self._restart_task
        if restart is not None and not restart.done():
            restart.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await restart
        proc = self.proc
        if proc is not None and proc.returncode is None:
            try:
                proc.stdin.write(b'{"type":"shutdown"}\n')
                await proc.stdin.drain()
            except (OSError, RuntimeError, AttributeError):
                pass
            try:
                await asyncio.wait_for(proc.wait(), STOP_WAIT_SECONDS)
            except asyncio.TimeoutError:
                self._kill("stopped")
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), STOP_WAIT_SECONDS)
        current = asyncio.current_task()
        pumps = [t for t in self._tasks if not t.done() and t is not current]
        if pumps:
            await asyncio.wait(pumps, timeout=STOP_WAIT_SECONDS)
        for t in list(self._tasks):
            if not t.done() and t is not current:
                t.cancel()
        self.state = "stopped"
        self._release_uid(self.uid)

    def _kill(self, reason: str) -> None:
        self._kill_reason = self._kill_reason or reason
        if self.pid is None:
            return
        try:
            os.killpg(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    # -- the two pipes ---------------------------------------------------------

    async def _pump_stderr(self, proc) -> None:
        while True:
            line = await proc.stderr.readline()
            if not line:
                return
            self.logs.add(self.plugin_id, self.version, line.decode("utf-8", "replace").rstrip("\n"))

    async def _pump_protocol(self, proc, reader, ready) -> None:
        try:
            while True:
                try:
                    line = await reader.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    self._event("worker sent an oversized protocol line; killing it")
                    self._kill("protocol_error")
                    break
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except ValueError:
                    msg = None
                if not isinstance(msg, dict):
                    self._event("worker sent a malformed protocol line; killing it")
                    self._kill("protocol_error")
                    break
                kind = msg.get("type")
                if kind == "ready" and not ready.done():
                    ready.set_result(msg)
                elif kind == "fatal" and not ready.done():
                    err = _clean_error(msg.get("error"))
                    ready.set_exception(RuntimeError(err["message"]))
                elif kind == "result":
                    fut = self.pending.get(msg.get("id"))
                    if fut is not None and not fut.done():
                        if msg.get("ok") is True and isinstance(msg.get("result"), dict):
                            fut.set_result({"ok": True, "result": msg["result"]})
                        elif msg.get("ok") is True:
                            fut.set_result({"ok": False, "error": {
                                "code": "invalid_result", "message": "The plugin returned something that is not a JSON object."}})
                        else:
                            fut.set_result({"ok": False, "error": _clean_error(msg.get("error"))})
        finally:
            code = await proc.wait()
            if not ready.done():
                ready.set_exception(RuntimeError(f"the worker exited with code {code} before it was ready"))
            self._on_exit(proc, code)

    # -- exit and restart ------------------------------------------------------

    def _on_exit(self, proc, code: int) -> None:
        if proc is not self.proc:
            return
        reason = self._kill_reason
        killed = kill_uid_processes(self.uid) if self.settings.spawn_as_user else 0
        extra = f", {killed} leftover process(es) killed" if killed else ""
        self._event(f"worker exited with code {code}" + (f" ({reason})" if reason else "") + extra)
        if reason is None:
            failure = RunnerError(502, "worker_crashed", "The plugin's worker stopped unexpectedly.")
        else:
            failure = RunnerError(502, "worker_restarted", "The plugin's worker was restarted.")
        for rid, fut in list(self.pending.items()):
            if fut.done():
                continue
            if rid in self._cancelled:
                fut.set_result({"ok": False, "error": {"code": "cancelled", "message": "The action was cancelled."}})
            else:
                fut.set_exception(failure)
        self.pending.clear()
        self._cancelled.clear()
        self.pid = None
        if self._stopping or self.state in ("failed", "starting") or not self._should_run(self):
            return
        self.state = "restarting"
        self._recent_crashes += 1
        self._restart_task = self._task(self._restart())

    async def _restart(self) -> None:
        delay = 0.0 if self._recent_crashes <= 1 else min(RESTART_BACKOFF_MAX, 0.5 * 2 ** (self._recent_crashes - 2))
        if delay:
            await self.clock.sleep(delay)
        if self._stopping or not self._should_run(self):
            return
        self.restarts += 1
        if await self.start():
            self._task(self._forget_crashes())
        elif not self._stopping and self._should_run(self):
            # A replacement that cannot start (a starved host) is retried with the same
            # backoff instead of staying down until the next run-list reload.
            self._recent_crashes += 1
            self.state = "restarting"
            self._restart_task = self._task(self._restart())

    async def _forget_crashes(self) -> None:
        await self.clock.sleep(60)
        self._recent_crashes = 0

    # -- calls -----------------------------------------------------------------

    async def _send(self, msg: dict) -> None:
        try:
            self.proc.stdin.write(json.dumps(msg, separators=(",", ":")).encode("utf-8") + b"\n")
            await self.proc.stdin.drain()
        except (OSError, RuntimeError, AttributeError):
            raise RunnerError(502, "worker_crashed", "The plugin's worker stopped unexpectedly.") from None

    async def invoke(self, action_id: str, params: dict, ctx: dict, token: str, timeout: float,
                     job_id: Optional[str] = None) -> dict:
        if self.state != "ready" or self.proc is None:
            raise RunnerError(503, "worker_unavailable", "The plugin's worker is not running right now.")
        if len(self.pending) >= self.settings.max_concurrent:
            raise RunnerError(429, "plugin_busy", "The plugin is already running as many actions as it may.")
        rid = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        if job_id:
            self.jobs[job_id] = rid
        try:
            await self._send({"type": "invoke", "id": rid, "action": action_id,
                              "entry": self.actions[action_id].entry, "params": params, "ctx": ctx,
                              "token": token})
            return await asyncio.wait_for(asyncio.shield(fut), timeout)
        except asyncio.TimeoutError:
            self.pending.pop(rid, None)
            self._event(f"action {action_id} timed out after {timeout:g}s; restarting the worker")
            self._kill("timeout")
            raise RunnerError(504, "action_timeout", f"The action did not finish within {timeout:g} seconds.") from None
        finally:
            self.pending.pop(rid, None)
            self._cancelled.discard(rid)
            if job_id:
                self.jobs.pop(job_id, None)

    async def cancel(self, job_id: str) -> bool:
        rid = self.jobs.get(job_id)
        if rid is None or rid not in self.pending:
            return False
        self._cancelled.add(rid)
        try:
            await self._send({"type": "cancel", "id": rid})
        except RunnerError:
            return True
        self._task(self._kill_if_still_running(rid))
        return True

    async def _kill_if_still_running(self, rid: str) -> None:
        await self.clock.sleep(self.settings.kill_grace)
        if rid in self.pending:
            self._event(f"a cancelled action did not stop within {self.settings.kill_grace:g}s; restarting the worker")
            self._kill("cancel")
