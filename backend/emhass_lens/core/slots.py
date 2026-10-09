"""Quarter-hour slot arithmetic. Slots are [start, start + 15 min) in UTC.

Quarter-hours line up with local quarter-hours for every timezone with a whole-quarter UTC offset,
which includes Estonia (UTC+2 / UTC+3).
"""

from datetime import UTC, datetime, timedelta

SLOT = timedelta(minutes=15)
SLOT_SECONDS = 900


def slot_floor(dt: datetime, step_s: int = SLOT_SECONDS) -> datetime:
    ts = int(dt.astimezone(UTC).timestamp())
    return datetime.fromtimestamp(ts - ts % step_s, UTC)


def slot_ceil(dt: datetime, step_s: int = SLOT_SECONDS) -> datetime:
    floor = slot_floor(dt, step_s)
    exact = dt.astimezone(UTC).timestamp() == floor.timestamp()
    return floor if exact else floor + timedelta(seconds=step_s)


def seconds_into_slot(dt: datetime, step_s: int = SLOT_SECONDS) -> float:
    return dt.astimezone(UTC).timestamp() - slot_floor(dt, step_s).timestamp()
