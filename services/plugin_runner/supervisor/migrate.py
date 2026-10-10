"""Data migrations (TD-28): one batch of rows through a plugin version's `migrate_row`.

Each batch runs in a temporary worker of that version, started like an action worker
(its own UID, clean environment, the same hardening) and stopped, its UID swept and
scrubbed, as soon as the batch is answered. The version need not be in the run list: an
update migrates with the new version before it becomes active. Migration code gets no
call token, so it cannot reach the Gateway; the webapp writes the answers into its copy.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import signal

from .runlist import PLUGIN_ID_RE, VERSION_RE
from .spawn import scrub, spawn
from .workers import STDERR_CHUNK, RunnerError, _clean_error, kill_uid_processes

MIGRATE_ROWS_MAX = 1000
OWNER_TYPES = ("user", "project")
ROW_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def check_body(body, plugins_dir: str, plugin_id: str):
    """(version, root, step, direction, rows), or raises ValueError (400) / RunnerError (404)."""
    if not isinstance(body, dict):
        raise ValueError("The body is not a JSON object.")
    if "token" in body:
        raise ValueError("A migration takes no call token: migration code has no Gateway access.")
    version, step, direction, rows = body.get("version"), body.get("step"), body.get("direction"), body.get("rows")
    if not isinstance(version, str) or not VERSION_RE.match(version):
        raise ValueError("version must be a version x.y.z.")
    if not isinstance(step, int) or isinstance(step, bool) or not 2 <= step <= 9999:
        raise ValueError("step must be a whole number from 2 to 9999.")
    if direction not in ("up", "down"):
        raise ValueError('direction must be "up" or "down".')
    if not isinstance(rows, list) or len(rows) > MIGRATE_ROWS_MAX:
        raise ValueError(f"rows must be a list of at most {MIGRATE_ROWS_MAX} rows.")
    for r in rows:
        if (not isinstance(r, dict) or not isinstance(r.get("id"), str) or not ROW_ID_RE.match(r["id"])
                or not isinstance(r.get("collection"), str) or not isinstance(r.get("key"), str)
                or r.get("ownerType") not in OWNER_TYPES or "value" not in r):
            raise ValueError("Every row needs id, collection, key, ownerType (user or project) and value.")
    expected = os.path.join(plugins_dir, plugin_id, "versions", version)
    if "root" in body and body["root"] != expected:
        raise ValueError(f"root must be {expected}.")
    base = os.path.realpath(plugins_dir)
    real = os.path.realpath(expected)
    if not PLUGIN_ID_RE.match(plugin_id) or not real.startswith(base + os.sep) or not os.path.isdir(real):
        raise RunnerError(404, "unknown_version", f"Plugin {plugin_id} {version} is not on the volume.")
    return version, real, step, direction, rows


async def _read_until(reader, want, timeout: float):
    """The first protocol message `want(msg)` accepts; a fatal line or EOF fails."""
    async def loop():
        while True:
            line = await reader.readline()
            if not line:
                raise RunnerError(502, "worker_crashed", "The migration worker stopped unexpectedly.")
            msg = json.loads(line)
            if isinstance(msg, dict) and msg.get("type") == "fatal":
                raise RunnerError(502, "worker_failed", _clean_error(msg.get("error"))["message"])
            if want(msg):
                return msg
    return await asyncio.wait_for(loop(), timeout)


async def run_batch(manager, plugin_id: str, version: str, root: str, step: int, direction: str, rows: list) -> list:
    settings, logs = manager.settings, manager.logs
    try:
        uid = manager._allocate_uid()
    except RuntimeError:
        raise RunnerError(503, "runner_busy", "No worker UID is free for the migration right now.") from None
    proc = None
    pump = None
    try:
        proc, reader = await spawn(settings, root, uid)

        async def pump_stderr():
            buf = b""
            while True:
                chunk = await proc.stderr.read(STDERR_CHUNK)
                if not chunk:
                    break
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for line in lines:
                    logs.add(plugin_id, version, line.decode("utf-8", "replace")[:8192])
            if buf:
                logs.add(plugin_id, version, buf.decode("utf-8", "replace")[:8192])

        pump = asyncio.ensure_future(pump_stderr())
        try:
            ready = await _read_until(reader, lambda m: m.get("type") == "ready", settings.ready_timeout)
        except asyncio.TimeoutError:
            raise RunnerError(502, "worker_failed", "The migration worker did not start in time.") from None
        logs.event(plugin_id, version, f"migration worker started: pid {ready.get('pid')} uid {uid} "
                                       f"(step {step} {direction}, {len(rows)} rows)")
        msg = {"type": "migrate", "id": "m", "step": step, "direction": direction, "rows": rows}
        proc.stdin.write(json.dumps(msg, separators=(",", ":")).encode("utf-8") + b"\n")
        try:
            await asyncio.wait_for(proc.stdin.drain(), settings.migrate_timeout)
            answer = await _read_until(reader, lambda m: m.get("type") == "result" and m.get("id") == "m",
                                       settings.migrate_timeout)
        except asyncio.TimeoutError:
            logs.event(plugin_id, version, f"migration step {step} {direction} timed out after "
                                           f"{settings.migrate_timeout:g}s; worker killed")
            raise RunnerError(504, "migration_timeout",
                              f"The migration did not finish a batch within {settings.migrate_timeout:g} seconds.") from None
        if answer.get("ok") is True and isinstance(answer.get("result"), dict):
            results = answer["result"].get("results")
            if isinstance(results, list):
                return results
            raise RunnerError(422, "invalid_result", "The migration worker answered without results.")
        err = _clean_error(answer.get("error"))
        logs.event(plugin_id, version, f"migration step {step} {direction} failed: {err['code']}")
        raise RunnerError(422, err["code"], err["message"])
    except (ValueError, TypeError):
        raise RunnerError(502, "worker_failed", "The migration worker sent a malformed protocol line.") from None
    finally:
        if proc is not None:
            with contextlib.suppress(OSError, RuntimeError, AttributeError):
                proc.stdin.write(b'{"type":"shutdown"}\n')
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)
            if settings.spawn_as_user and uid is not None:
                kill_uid_processes(uid)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), 5)
        if pump is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(pump, 2)
            pump.cancel()
        if settings.spawn_as_user and uid is not None:
            try:
                await scrub(settings, uid)
                manager._release_uid(uid)
            except Exception as e:
                # Never handed on with something of this plugin's still in it.
                logs.event(plugin_id, version, f"could not scrub UID {uid}, which stays out of use: {e}")
        else:
            manager._release_uid(uid)
