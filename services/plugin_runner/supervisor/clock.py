"""Time, injectable so tests do not wait on real backoffs."""

import asyncio
import time
from datetime import datetime, timezone


class Clock:
    def monotonic(self) -> float:
        return time.monotonic()

    def now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


SYSTEM_CLOCK = Clock()
