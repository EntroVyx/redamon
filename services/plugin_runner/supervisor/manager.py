"""The set of running workers, converged on the webapp's run list."""

from __future__ import annotations

import asyncio
import secrets
from typing import Optional

from platform_version import PLATFORM_VERSION

from . import runlist
from .workers import WorkerHandle


class Manager:
    def __init__(self, settings, logs, clock, client):
        self.settings = settings
        self.logs = logs
        self.clock = clock
        self.client = client
        # Reported in /health; the webapp stores it on each async job so a job dispatched to
        # a runner that has since restarted is failed at once (TD-22).
        self.boot_id = secrets.token_hex(16)
        self.state = "degraded"
        self.has_list = False
        self.workers: dict = {}
        self.desired: set = set()
        self._uids: set = set()
        self._next_uid = settings.uid_range[0]
        self._lock = asyncio.Lock()
        self.job_tasks: set = set()

    def log(self, message: str) -> None:
        print(f"[runner] {message}", flush=True)

    # -- uids ------------------------------------------------------------------

    def _allocate_uid(self) -> Optional[int]:
        """The next free UID after the last one handed out: a released UID is the last to
        be reused, by then long scrubbed."""
        if not self.settings.spawn_as_user:
            return None
        low, high = self.settings.uid_range
        span = high - low + 1
        for i in range(span):
            uid = low + (self._next_uid - low + i) % span
            if uid not in self._uids:
                self._uids.add(uid)
                self._next_uid = uid + 1
                return uid
        raise RuntimeError("no free worker UID")

    def _release_uid(self, uid: Optional[int]) -> None:
        self._uids.discard(uid)

    # -- convergence -----------------------------------------------------------

    def _should_run(self, handle: WorkerHandle) -> bool:
        return self.workers.get((handle.plugin_id, handle.version)) is handle and self.state != "out_of_date"

    async def reload(self) -> str:
        async with self._lock:
            try:
                body = await runlist.fetch(self.client, self.settings)
            except runlist.RunListError as e:
                self.log(f"run list unavailable, keeping the last good one: {e}")
                self.state = "degraded"
                return self.state
            self.has_list = True
            if body["platformVersion"] != PLATFORM_VERSION:
                self.log(f"the webapp runs platform {body['platformVersion']}, this runner "
                         f"{PLATFORM_VERSION}: out of date, no worker runs")
                self.state = "out_of_date"
                await self._converge([])
                return self.state
            self.state = "ok"
            await self._converge(runlist.parse_entries(body, self.settings.plugins_dir, self.log))
            return self.state

    async def _converge(self, entries: list) -> None:
        wanted = {e.key: e for e in entries}
        self.desired = set(wanted)
        removed = [h for key, h in self.workers.items() if key not in wanted]
        for key in [k for k in self.workers if k not in wanted]:
            del self.workers[key]
        starts = []
        # The removed workers are stopped whatever happens to the new ones: they are no
        # longer tracked anywhere else.
        try:
            for key, entry in wanted.items():
                handle = self.workers.get(key)
                if handle is not None:
                    handle.entry = entry  # the same version: only the action list may differ
                    if handle.state == "failed":
                        starts.append(handle.start())
                    continue
                try:
                    uid = self._allocate_uid()
                except RuntimeError as e:
                    self.log(f"{key[0]} {key[1]} not started, retried at the next reload: {e}")
                    continue
                handle = WorkerHandle(settings=self.settings, logs=self.logs, clock=self.clock, entry=entry,
                                      uid=uid, should_run=self._should_run, release_uid=self._release_uid)
                self.workers[key] = handle
                starts.append(handle.start())
            # New versions first, then the replaced ones go: an update never leaves a gap.
            if starts:
                await asyncio.gather(*starts, return_exceptions=True)
        finally:
            if removed:
                await asyncio.gather(*(h.stop() for h in removed), return_exceptions=True)

    async def periodic(self) -> None:
        while True:
            # Until the first list arrives (the webapp may still be booting), ask sooner.
            interval = self.settings.reload_interval if self.has_list else min(5.0, self.settings.reload_interval)
            await self.clock.sleep(interval)
            try:
                await self.reload()
            except Exception as e:  # never let the loop die
                self.log(f"reload failed: {type(e).__name__}: {e}")

    async def stop_all(self) -> None:
        handles = list(self.workers.values())
        self.workers.clear()
        await asyncio.gather(*(h.stop() for h in handles), return_exceptions=True)
        for t in list(self.job_tasks):
            t.cancel()

    # -- lookups ---------------------------------------------------------------

    def find(self, plugin_id: str, version: Optional[str]) -> Optional[WorkerHandle]:
        if version:
            return self.workers.get((plugin_id, version))
        matches = [h for (pid, _), h in self.workers.items() if pid == plugin_id]
        return matches[0] if len(matches) == 1 else None

    def job_running(self, plugin_id: str, job_id: str) -> bool:
        return any(job_id in h.jobs for (pid, _), h in self.workers.items() if pid == plugin_id)

    async def cancel(self, plugin_id: str, job_id: str) -> bool:
        for (pid, _), h in list(self.workers.items()):
            if pid == plugin_id and await h.cancel(job_id):
                return True
        return False

    def health(self) -> dict:
        return {"platformVersion": PLATFORM_VERSION, "bootId": self.boot_id, "state": self.state,
                "workers": [h.describe() for h in self.workers.values()]}
