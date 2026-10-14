"""
The plugin platform's reconcile tick (TD-20, RV-16): the webapp has no scheduler, so the
orchestrator's reaper asks it to reconcile plugins every PLUGIN_RECONCILE_INTERVAL.

The reaper awaits every step in turn, and the same loop releases governor reservations
and dispatches the scan queue, so the tick must:
  - POST /api/internal/plugins/reconcile with the internal key at most once per interval,
  - start the POST as a background task and never await it (a slow webapp never delays
    the next step), with an in-flight guard (no second POST while one runs),
  - survive an empty or bad PLUGIN_RECONCILE_INTERVAL (300 s),
  - never raise when the webapp is down,
  - on a 404 (an older webapp image) log one line and stop calling until the
    orchestrator restarts.

Run: python3 -m unittest tests.test_plugin_reconcile_tick   (from /app in the
recon-orchestrator container).
"""
from __future__ import annotations

import asyncio
import inspect
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import api  # noqa: E402


class _FakeWebapp:
    """Records every request; answers `status` after `delay` seconds."""

    def __init__(self, status=200, delay=0.0):
        self.requests = []
        self.status = status
        self.delay = delay
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                fake.requests.append((self.path, dict(self.headers), body))
                if fake.delay:
                    time.sleep(fake.delay)
                payload = b'{"ok":true}'
                self.send_response(fake.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    @property
    def base(self):
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class TestReconcileTick(unittest.TestCase):
    def setUp(self):
        self.web = _FakeWebapp()
        self.env = mock.patch.dict(os.environ, {
            "INTERNAL_API_KEY": "k" * 64, "WEBAPP_API_URL": self.web.base,
        })
        self.env.start()
        api._reset_plugin_reconcile_state()
        self.interval = mock.patch.object(api, "PLUGIN_RECONCILE_INTERVAL_S", 300)
        self.interval.start()

    def tearDown(self):
        self.interval.stop()
        self.env.stop()
        self.web.close()
        api._reset_plugin_reconcile_state()

    def run_async(self, coro):
        return asyncio.run(coro)

    async def _tick_and_wait(self):
        await api._maybe_reconcile_plugins()
        task = api._plugin_reconcile_task
        if task is not None:
            await task

    def test_posts_the_reconcile_route_with_the_internal_key(self):
        self.run_async(self._tick_and_wait())
        self.assertEqual(len(self.web.requests), 1)
        path, headers, _ = self.web.requests[0]
        self.assertEqual(path, "/api/internal/plugins/reconcile")
        lowered = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(lowered.get("x-internal-key"), "k" * 64)

    def test_at_most_once_per_interval(self):
        async def ticks():
            for _ in range(3):
                await self._tick_and_wait()
        self.run_async(ticks())
        self.assertEqual(len(self.web.requests), 1)
        with mock.patch.object(api.time, "monotonic", return_value=time.monotonic() + 301):
            self.run_async(self._tick_and_wait())
        self.assertEqual(len(self.web.requests), 2)

    def test_a_slow_webapp_never_delays_the_loop_and_is_not_called_twice(self):
        self.web.delay = 1.5

        async def scenario():
            started = time.monotonic()
            await api._maybe_reconcile_plugins()
            first = time.monotonic() - started
            with mock.patch.object(api.time, "monotonic", return_value=time.monotonic() + 301):
                await api._maybe_reconcile_plugins()  # due again, but one is in flight
            await api._plugin_reconcile_task
            return first

        took = self.run_async(scenario())
        self.assertLess(took, 0.3)
        self.assertEqual(len(self.web.requests), 1)

    def test_the_interval_survives_an_empty_or_bad_value(self):
        for raw, expected in (("", 300), ("   ", 300), ("abc", 300), ("-5", 300), ("0", 300), ("120", 120)):
            with mock.patch.dict(os.environ, {"PLUGIN_RECONCILE_INTERVAL": raw}):
                self.assertEqual(api._interval_from_env("PLUGIN_RECONCILE_INTERVAL", 300), expected, raw)

    def test_the_webapp_down_never_raises(self):
        self.web.close()
        self.run_async(self._tick_and_wait())  # no exception

    def test_a_404_is_logged_once_and_calling_stops(self):
        self.web.status = 404
        with self.assertLogs(api.logger, level="WARNING") as logs:
            self.run_async(self._tick_and_wait())
            with mock.patch.object(api.time, "monotonic", return_value=time.monotonic() + 301):
                self.run_async(self._tick_and_wait())
                self.run_async(self._tick_and_wait())
        self.assertEqual(len(self.web.requests), 1)
        self.assertEqual(sum("plugins" in line for line in logs.output), 1)

    def test_other_errors_keep_calling_at_the_next_interval(self):
        self.web.status = 500
        self.run_async(self._tick_and_wait())
        with mock.patch.object(api.time, "monotonic", return_value=time.monotonic() + 301):
            self.run_async(self._tick_and_wait())
        self.assertEqual(len(self.web.requests), 2)

    def test_the_reaper_runs_the_tick_and_the_compose_file_passes_its_settings(self):
        self.assertIn("_maybe_reconcile_plugins()", inspect.getsource(api._ai_attack_reaper))
        import re
        compose = (ROOT.parent / "docker-compose.yml").read_text()
        # The recon-orchestrator service, up to the next service at the same indent: it has
        # no env_file, so only what its own environment block lists reaches it.
        block = re.search(r"\n  recon-orchestrator:\n(.*?)(?=\n  [a-z][a-z0-9_-]*:\n)", compose, re.S).group(1)
        self.assertIn("PLUGIN_RECONCILE_INTERVAL: ${PLUGIN_RECONCILE_INTERVAL:-300}", block)


if __name__ == "__main__":
    unittest.main()
