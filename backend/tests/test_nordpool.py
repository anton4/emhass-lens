from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from emhass_lens.domain import nordpool
from emhass_lens.domain.poll_policy import DayState, PollConfig, decide, needed_days
from tests.fixtures.loader import load_json, synthetic_nordpool
from tests.fixtures.loader import nordpool as np_fixture

TZ = ZoneInfo("Europe/Tallinn")
CFG = PollConfig(time(13, 45), time(15, 0), timedelta(minutes=5), timedelta(minutes=60))


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_parse_real_day() -> None:
    day = nordpool.parse(np_fixture("2026-10-09"), date(2026, 10, 9), "EE")
    assert day.state == "Final"
    assert len(day.entries) == 96
    assert day.resolution_min == 15
    assert day.entries[0].start == utc(2026, 10, 8, 22, 0)  # 00:00 CEST = 01:00 EEST
    assert day.entries[0].eur_mwh == 27.99


def test_unauthorized_body_parses_to_nothing() -> None:
    day = nordpool.parse(load_json("nordpool", "np_401.json"), date(2026, 3, 28), "EE")
    assert day.entries == ()
    assert day.state == "Unknown"


def test_dst_end_day_has_100_slots_and_hourly_data_is_split() -> None:
    # 2026-10-25 CET delivery day: 00:00 CEST (22:00Z on the 24th) to 00:00 CET (23:00Z on the 25th) = 25 h
    body = synthetic_nordpool("2026-10-25", utc(2026, 10, 24, 22, 0), 100)
    assert len(nordpool.parse(body, date(2026, 10, 25), "EE").entries) == 100
    hourly = synthetic_nordpool("2025-09-15", utc(2025, 9, 14, 22, 0), 24, step_min=60)
    parsed = nordpool.parse(hourly, date(2025, 9, 15), "EE")
    assert parsed.resolution_min == 60
    quarters = nordpool.to_quarter_hours(parsed.entries)
    assert len(quarters) == 96
    assert quarters[0].eur_mwh == quarters[3].eur_mwh


def test_local_day_needs_three_delivery_days_until_midnight_slot_is_covered() -> None:
    # Local 2026-10-09 00:00 EEST = 2026-10-08 23:00 CEST -> delivery day 10-08 holds the first local hour
    assert needed_days(utc(2026, 10, 9, 8, 0), TZ) == [date(2026, 10, 8), date(2026, 10, 9), date(2026, 10, 10)]


def test_policy_fetches_missing_delivered_days_now_and_waits_for_publication() -> None:
    now = utc(2026, 10, 9, 6, 0)  # 09:00 local
    decisions = decide(now, TZ, {}, CFG)
    by_day = {d.day: d for d in decisions}
    assert by_day[date(2026, 10, 8)].due_at == now
    assert by_day[date(2026, 10, 9)].due_at == now
    tomorrow = by_day[date(2026, 10, 10)]
    assert tomorrow.due_at == datetime(2026, 10, 9, 13, 45, tzinfo=TZ)
    assert "expected at 13:45" in tomorrow.reason


def test_policy_fast_then_slow_window_and_final_stops() -> None:
    final = DayState(date(2026, 10, 9), "Final", 96)
    prev = DayState(date(2026, 10, 8), "Final", 96)
    tried = datetime(2026, 10, 9, 13, 50, tzinfo=TZ)
    states = {prev.day: prev, final.day: final,
              date(2026, 10, 10): DayState(date(2026, 10, 10), None, 0, last_attempt=tried, not_published=True)}
    [d] = decide(datetime(2026, 10, 9, 13, 52, tzinfo=TZ), TZ, states, CFG)
    assert d.due_at == tried + timedelta(minutes=5)
    assert "fast window" in d.reason
    late = datetime(2026, 10, 9, 15, 10, tzinfo=TZ)
    states[date(2026, 10, 10)] = DayState(date(2026, 10, 10), None, 0, last_attempt=late, not_published=True)
    [d] = decide(late, TZ, states, CFG)
    assert d.due_at == late + timedelta(minutes=60)
    states[date(2026, 10, 10)] = DayState(date(2026, 10, 10), "Final", 96)
    assert decide(late, TZ, states, CFG) == []


def test_policy_backs_off_after_errors_per_day() -> None:
    failed_at = datetime(2026, 10, 9, 9, 0, tzinfo=TZ)
    states = {date(2026, 10, 9): DayState(date(2026, 10, 9), None, 0, last_attempt=failed_at, consecutive_errors=3)}
    by_day = {d.day: d for d in decide(failed_at + timedelta(seconds=10), TZ, states, CFG)}
    assert by_day[date(2026, 10, 9)].due_at == failed_at + timedelta(minutes=5)
    assert by_day[date(2026, 10, 8)].due_at == failed_at + timedelta(seconds=10)  # other days aren't blocked
