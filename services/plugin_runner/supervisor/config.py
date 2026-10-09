"""Supervisor settings, read once from the environment (compose `environment:` block).

A missing, empty or invalid number falls back to its default, never to 0, which would
disable a limit. Only PLUGIN_RUNNER_KEY reaches this process from the secrets; the
call-token secret never does, so a compromised runner cannot mint tokens.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field

DEFAULT_ACTION_MAX_TIMEOUT = 900
DEFAULT_MAX_CONCURRENT = 4
DEFAULT_WORKER_MEM_MB = 512
DEFAULT_WORKER_NPROC = 64
DEFAULT_RELOAD_INTERVAL = 60.0
DEFAULT_PORT = 7080
# Worker UIDs. Never 0, never a user the image defines (webapp's nextjs is 1001).
UID_RANGE = (20000, 29999)


def _positive_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw.isdigit():
        return default
    value = int(raw)
    return value if value > 0 else default


@dataclass(frozen=True)
class Settings:
    runner_key: str
    gateway_url: str
    plugins_dir: str = "/plugins"
    sdk_dir: str = "/opt/runner/sdk"
    bootstrap: str = "/opt/runner/worker/bootstrap.py"
    python: str = sys.executable
    action_max_timeout: int = DEFAULT_ACTION_MAX_TIMEOUT
    max_concurrent: int = DEFAULT_MAX_CONCURRENT
    worker_mem_mb: int = DEFAULT_WORKER_MEM_MB
    worker_nproc: int = DEFAULT_WORKER_NPROC
    reload_interval: float = DEFAULT_RELOAD_INTERVAL
    # Production runs as root and gives each worker its own UID; a test run as a normal
    # user cannot, and keeps its own.
    spawn_as_user: bool = True
    uid_range: tuple = UID_RANGE
    # How long a cancelled action may take to stop before its worker is killed.
    kill_grace: float = 5.0
    # Waits before the 2nd, 3rd and 4th attempt to report a finished job.
    job_report_delays: tuple = field(default=(1.0, 2.0, 4.0))
    # How long a new worker may take to say `ready`; generous for a loaded host.
    ready_timeout: float = 30.0
    log_lines: int = 1000

    @property
    def configured(self) -> bool:
        """A missing or placeholder key leaves every route closed (TD-08)."""
        return bool(self.runner_key) and self.runner_key != "changeme"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            runner_key=(os.environ.get("PLUGIN_RUNNER_KEY") or "").strip(),
            gateway_url=(os.environ.get("PLUGIN_GATEWAY_URL") or "http://plugin-gateway:7071").rstrip("/"),
            plugins_dir=os.environ.get("PLUGINS_DIR") or "/plugins",
            action_max_timeout=_positive_int("PLUGIN_ACTION_MAX_TIMEOUT", DEFAULT_ACTION_MAX_TIMEOUT),
            max_concurrent=_positive_int("PLUGIN_MAX_CONCURRENT_ACTIONS", DEFAULT_MAX_CONCURRENT),
            worker_mem_mb=_positive_int("PLUGIN_WORKER_MEM_MB", DEFAULT_WORKER_MEM_MB),
            worker_nproc=_positive_int("PLUGIN_WORKER_NPROC", DEFAULT_WORKER_NPROC),
            spawn_as_user=os.geteuid() == 0,
        )
