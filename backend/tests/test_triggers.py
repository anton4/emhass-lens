from datetime import UTC, datetime, time

from emhass_lens.scheduler.triggers import Daily, Periodic, QuarterHour


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_quarter_hour_offset_fires_at_13_past_each_quarter() -> None:
    trigger = QuarterHour(13 * 60)
    assert trigger.next_after(utc(2026, 10, 9, 11, 0, 0)) == utc(2026, 10, 9, 11, 13, 0)
    assert trigger.next_after(utc(2026, 10, 9, 11, 13, 0)) == utc(2026, 10, 9, 11, 28, 0)
    assert trigger.next_after(utc(2026, 10, 9, 11, 58, 30)) == utc(2026, 10, 9, 12, 13, 0)
    assert trigger.describe() == "Every quarter-hour at :13:00, :28:00, :43:00, :58:00"


def test_periodic_strictly_after() -> None:
    trigger = Periodic(60)
    assert trigger.next_after(utc(2026, 1, 1, 0, 0, 0)) == utc(2026, 1, 1, 0, 1, 0)
    assert trigger.next_after(utc(2026, 1, 1, 0, 0, 59)) == utc(2026, 1, 1, 0, 1, 0)


def test_daily_follows_local_time_across_dst_end() -> None:
    trigger = Daily(time(3, 30), "Europe/Tallinn")
    # 2026-10-25: clocks go back from 04:00 EEST to 03:00 EET; 03:30 local happens twice (first = EEST).
    before = utc(2026, 10, 24, 12, 0)
    first = trigger.next_after(before)
    assert first == utc(2026, 10, 25, 0, 30)  # 03:30 EEST (UTC+3)
    after_change = trigger.next_after(utc(2026, 10, 25, 12, 0))
    assert after_change == utc(2026, 10, 26, 1, 30)  # 03:30 EET (UTC+2)


def test_daily_skips_nonexistent_spring_time() -> None:
    trigger = Daily(time(3, 30), "Europe/Tallinn")
    # 2026-03-29: 03:00 -> 04:00 local; 03:30 doesn't exist and zoneinfo maps it to 04:30 EEST (01:30 UTC).
    assert trigger.next_after(utc(2026, 3, 28, 12, 0)) == utc(2026, 3, 29, 1, 30)
