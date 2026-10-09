"""Plugin logs: the last N lines per plugin in memory (served to admins by the logs route)
and every line on the container's stdout with a `[plugin:<id>@<version>]` prefix.

Worker output can carry transcript or target text a plugin printed, so the buffer is
bounded (lines and line length) and the container log is rotated by compose.
"""

from __future__ import annotations

import sys
import threading
from collections import deque
from typing import Optional, TextIO

LINE_MAX_CHARS = 4000


class LogBuffer:
    def __init__(self, max_lines: int = 1000, stream: Optional[TextIO] = None):
        self._max = max_lines
        self._stream = stream
        self._buffers: dict = {}
        self._lock = threading.Lock()

    def add(self, plugin_id: str, version: str, line: str) -> None:
        if len(line) > LINE_MAX_CHARS:
            line = line[:LINE_MAX_CHARS] + f" [... {len(line) - LINE_MAX_CHARS} characters cut]"
        stamped = f"{version} {line}"
        with self._lock:
            buf = self._buffers.get(plugin_id)
            if buf is None:
                buf = self._buffers[plugin_id] = deque(maxlen=self._max)
            buf.append(stamped)
        stream = self._stream or sys.stdout
        try:
            stream.write(f"[plugin:{plugin_id}@{version}] {line}\n")
            stream.flush()
        except (OSError, ValueError):
            pass

    def event(self, plugin_id: str, version: str, message: str) -> None:
        """A supervisor event about the plugin's worker, in the same log."""
        self.add(plugin_id, version, f"[runner] {message}")

    def tail(self, plugin_id: str, lines: int) -> list:
        with self._lock:
            buf = self._buffers.get(plugin_id)
            if not buf or lines <= 0:
                return []
            return list(buf)[-lines:]
