"""Time source. Everything that needs "now" takes a Clock, so tests can freeze and move time."""

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime:
        """Current time, timezone-aware UTC."""
        ...

    async def wait(self, event: asyncio.Event, seconds: float) -> bool:
        """Wait until the event is set or `seconds` pass. True if the event was set."""
        ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)

    async def wait(self, event: asyncio.Event, seconds: float) -> bool:
        try:
            async with asyncio.timeout(max(0.0, seconds)):
                await event.wait()
            return True
        except TimeoutError:
            return False


class FakeClock:
    """Manually driven clock for tests: time only moves when advance() or set() is called."""

    def __init__(self, start: datetime) -> None:
        if start.tzinfo is None:
            raise ValueError("FakeClock needs a timezone-aware start time")
        self._now = start.astimezone(UTC)

    def now(self) -> datetime:
        return self._now

    def set(self, when: datetime) -> None:
        self._now = when.astimezone(UTC)

    def advance(self, seconds: float = 0, **kwargs: float) -> datetime:
        self._now += timedelta(seconds=seconds, **kwargs)
        return self._now

    async def wait(self, event: asyncio.Event, seconds: float) -> bool:
        await asyncio.sleep(0)
        return event.is_set()


def iso(dt: datetime | None) -> str | None:
    """ISO 8601 in UTC with millisecond precision, the one timestamp format stored and served."""
    if dt is None:
        return None
    return dt.astimezone(UTC).isoformat(timespec="milliseconds")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
