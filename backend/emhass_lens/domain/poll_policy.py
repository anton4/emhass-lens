"""When to (re)fetch which Nord Pool delivery day, and why. Pure: state in, decisions out.

Rules (kept from the HACS integration, but per delivery day):
- Days that are already being delivered are fetched as soon as they're missing.
- Tomorrow's day is not expected before `publish_time` (local); between publish_time and
  `fast_until` it is polled every `fast_interval`, afterwards every `slow_interval`.
- A Final day is never fetched again; a Preliminary one is re-polled at the slow interval.
- A fetch error backs off 1 → 2 → 5 → 10 minutes and never blocks the other days.
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from emhass_lens.domain.nordpool import CET, delivery_days_covering

BACKOFF_MIN = (1, 2, 5, 10)


@dataclass(frozen=True)
class DayState:
    day: date
    state: str | None = None  # Final | Preliminary | Unknown | None (never fetched or not published)
    slots: int = 0
    last_attempt: datetime | None = None
    last_success: datetime | None = None
    consecutive_errors: int = 0
    not_published: bool = False


@dataclass(frozen=True)
class PollDecision:
    day: date
    due_at: datetime
    reason: str


@dataclass(frozen=True)
class PollConfig:
    publish_time: time
    fast_until: time
    fast_interval: timedelta
    slow_interval: timedelta


def needed_days(now: datetime, tz: ZoneInfo) -> list[date]:
    """CET delivery days covering local today and local tomorrow."""
    local = now.astimezone(tz)
    start = datetime.combine(local.date(), time(0), tzinfo=tz)
    # local midnights, so DST days come out 23 or 25 hours long
    end = datetime.combine((local + timedelta(days=2)).date(), time(0), tzinfo=tz)
    return delivery_days_covering(start, end)


def _local(day: date, at: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(day, at, tzinfo=tz)


def decide(now: datetime, tz: ZoneInfo, states: dict[date, DayState], cfg: PollConfig) -> list[PollDecision]:
    """One decision per needed delivery day that isn't final, sorted by due time."""
    decisions: list[PollDecision] = []
    today_cet = now.astimezone(CET).date()
    local_today = now.astimezone(tz).date()
    publish_at = _local(local_today, cfg.publish_time, tz)
    fast_end = _local(local_today, cfg.fast_until, tz)

    for day in needed_days(now, tz):
        st = states.get(day, DayState(day))
        if st.state == "Final" and st.slots > 0:
            continue

        if st.consecutive_errors and st.last_attempt:
            wait = BACKOFF_MIN[min(st.consecutive_errors, len(BACKOFF_MIN)) - 1]
            due = st.last_attempt + timedelta(minutes=wait)
            decisions.append(
                PollDecision(day, due, f"retry after {st.consecutive_errors} failed attempt(s), backoff {wait} min")
            )
            continue

        if day <= today_cet:
            if st.slots == 0:
                decisions.append(PollDecision(day, now, "prices for a day being delivered are missing"))
            else:  # Preliminary for a day already being delivered: re-check slowly
                due = (st.last_attempt or now) + cfg.slow_interval
                decisions.append(PollDecision(day, due, f"state {st.state}; re-check until Final"))
            continue

        # tomorrow's delivery day
        if now < publish_at:
            decisions.append(
                PollDecision(day, publish_at, f"day-ahead results are expected at {cfg.publish_time:%H:%M}")
            )
            continue
        interval = cfg.fast_interval if now < fast_end else cfg.slow_interval
        window = "fast" if now < fast_end else "slow"
        if st.last_attempt is None or st.last_attempt < publish_at:
            due = now
        else:
            due = st.last_attempt + interval
        if st.last_attempt is None:
            what = "not fetched yet"
        elif st.not_published or st.slots == 0:
            what = "not published yet"
        else:
            what = f"state {st.state}"
        decisions.append(
            PollDecision(day, due, f"tomorrow {what}; {window} window, every {int(interval.total_seconds() // 60)} min")
        )

    decisions.sort(key=lambda d: d.due_at)
    return decisions
