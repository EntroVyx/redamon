"""How a worker process is started (TD-04, RV-09).

The UID, groups and process group are applied by subprocess in C between fork and exec.
A Python callback run there is unsafe once the parent has threads, and this one runs
uvicorn and asyncio, so the worker lowers its own limits itself as the first thing
worker/bootstrap.py does. Nothing of this process's environment is passed on: the
worker gets only the variables listed here, none of them a secret.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from typing import Optional

# The protocol line limit: a 2 MB result plus its envelope.
PROTO_LINE_LIMIT = 2 * 1024 * 1024 + 64 * 1024


def worker_env(settings) -> dict:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
        "REDAMON_GATEWAY_URL": settings.gateway_url,
    }


def worker_argv(settings, root: str, proto_fd: int) -> list:
    return [settings.python, "-I", "-S", settings.bootstrap, "--root", root,
            "--sdk", settings.sdk_dir, "--mem-mb", str(settings.worker_mem_mb),
            "--nproc", str(settings.worker_nproc), "--proto-fd", str(proto_fd)]


async def spawn(settings, root: str, uid: Optional[int]):
    """Starts a worker; returns (process, protocol StreamReader)."""
    read_fd, write_fd = os.pipe()
    kwargs = dict(stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
                  stderr=asyncio.subprocess.PIPE, pass_fds=(write_fd,), env=worker_env(settings),
                  cwd="/", process_group=0, close_fds=True)
    if uid is not None:
        kwargs.update(user=uid, group=uid, extra_groups=[])
    try:
        proc = await asyncio.create_subprocess_exec(*worker_argv(settings, root, write_fd), **kwargs)
    except BaseException:
        os.close(read_fd)
        raise
    finally:
        os.close(write_fd)
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=PROTO_LINE_LIMIT)
    try:
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader),
                                     os.fdopen(read_fd, "rb", buffering=0))
    except BaseException:
        # Cancelled or failed after the fork: nobody else knows this process exists.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        raise
    return proc, reader
