"""When jobs fire. All triggers work in UTC; Daily converts its local time with zoneinfo (DST-safe)."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo


class Trigger(Protocol):
    def next_after(self, after: datetime) -> datetime | None:
        """The first fire time strictly after `after` (UTC), or None for never."""
        ...

    def describe(self) -> str: ...


@dataclass(frozen=True)
class Periodic:
    """Every `period_s` seconds, aligned to the epoch, plus `offset_s`.

    Periodic(900, 780) fires at hh:13:00, hh:28:00, hh:43:00 and hh:58:00.
    """

    period_s: int
    offset_s: int = 0

    def next_after(self, after: datetime) -> datetime | None:
        ts = after.astimezone(UTC).timestamp()
        base = ts - ((ts - self.offset_s) % self.period_s)
        nxt = base + self.period_s if base <= ts else base
        return datetime.fromtimestamp(nxt, UTC)

    def describe(self) -> str:
        if self.period_s == 900:
            minutes, seconds = divmod(self.offset_s, 60)
            marks = ", ".join(f":{(minutes + 15 * i) % 60:02d}:{seconds:02d}" for i in range(4))
            return f"Every quarter-hour at {marks}"
        if self.period_s % 3600 == 0:
            hours = self.period_s // 3600
            return f"Every {hours} h" if hours > 1 else "Every hour"
        if self.period_s % 60 == 0:
            return f"Every {self.period_s // 60} min"
        return f"Every {self.period_s} s"


def QuarterHour(offset_s: int) -> Periodic:
    return Periodic(900, offset_s % 900)


@dataclass(frozen=True)
class Daily:
    at: time
    tz: str

    def next_after(self, after: datetime) -> datetime | None:
        zone = ZoneInfo(self.tz)
        local_day = after.astimezone(zone).date()
        for offset in range(3):
            day = local_day + timedelta(days=offset)
            candidate = datetime.combine(day, self.at, tzinfo=zone).astimezone(UTC)
            if candidate > after:
                return candidate
        return None

    def describe(self) -> str:
        return f"Daily at {self.at.strftime('%H:%M')} ({self.tz})"


@dataclass(frozen=True)
class Dynamic:
    """The job decides its own next time (e.g. the Nord Pool poll state machine)."""

    compute: Callable[[datetime], datetime | None]
    text: str = "Dynamic"

    def next_after(self, after: datetime) -> datetime | None:
        return self.compute(after)

    def describe(self) -> str:
        return self.text


@dataclass(frozen=True)
class Manual:
    def next_after(self, after: datetime) -> datetime | None:
        return None

    def describe(self) -> str:
        return "Manual only"
