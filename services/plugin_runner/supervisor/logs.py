"""Plugin logs: the last N lines per plugin in memory (served to admins by the logs route)
and every line on the container's stdout with a `[plugin:<id>@<version>]` prefix.

Worker output can carry transcript or target text a plugin printed, so the buffer is
bounded (lines and line length) and the container log is rotated by compose.
"""

from __future__ import annotations

import re
import sys
import threading
from collections import deque
from typing import Optional, TextIO

LINE_MAX_CHARS = 4000
EVENT_PREFIX = "[runner] "
# Control characters but the tab: a plugin's ESC sequences or carriage returns would
# otherwise rewrite an admin's terminal (`docker logs`) or earlier lines.
CONTROL_RE = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")


class LogBuffer:
    def __init__(self, max_lines: int = 1000, stream: Optional[TextIO] = None):
        self._max = max_lines
        self._stream = stream
        self._buffers: dict = {}
        self._lock = threading.Lock()

    def add(self, plugin_id: str, version: str, line: str, cut: int = 0) -> None:
        """One line a plugin printed; `cut` counts what the reader already dropped of it."""
        line = CONTROL_RE.sub(lambda m: f"\\x{ord(m.group()):02x}", line)
        if len(line) > LINE_MAX_CHARS:
            cut += len(line) - LINE_MAX_CHARS
            line = line[:LINE_MAX_CHARS]
        if line.startswith(EVENT_PREFIX.strip()):
            line = "[plugin] " + line  # never mistaken for the supervisor's own events
        if cut:
            line += f" [... {cut} characters cut]"
        self._append(plugin_id, version, line)

    def event(self, plugin_id: str, version: str, message: str) -> None:
        """A supervisor event about the plugin's worker, in the same log."""
        self._append(plugin_id, version, EVENT_PREFIX + message)

    def _append(self, plugin_id: str, version: str, line: str) -> None:
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

    def tail(self, plugin_id: str, lines: int) -> list:
        with self._lock:
            buf = self._buffers.get(plugin_id)
            if not buf or lines <= 0:
                return []
            return list(buf)[-lines:]
