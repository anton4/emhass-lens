"""Quarter-hour means from recorder history (domain/measure.py)."""

from datetime import UTC, datetime, timedelta

from emhass_lens.domain.measure import numeric, slot_means

T0 = datetime(2026, 10, 9, 10, 0, tzinfo=UTC)


def item(minutes: float, state: str) -> dict[str, str]:
    return {"state": state, "last_changed": (T0 + timedelta(minutes=minutes)).isoformat()}


def test_numeric_accepts_numbers_and_rejects_the_rest() -> None:
    assert numeric("1500") == 1500.0
    assert numeric(12) == 12.0
    assert numeric("unavailable") is None
    assert numeric("unknown") is None
    assert numeric("nan") is None
    assert numeric(True) is None
    assert numeric(None) is None


def test_a_state_from_before_the_window_holds_until_the_first_change() -> None:
    states = [item(-30, "1000"), item(20, "2000")]  # 1000 W until 10:20, then 2000 W
    means = slot_means(states, T0, T0 + timedelta(minutes=30))
    assert [m.start for m in means] == [T0, T0 + timedelta(minutes=15)]
    assert means[0].value == 1000.0 and means[0].coverage == 1.0
    assert means[1].value == (1000 * 300 + 2000 * 600) / 900  # 5 min at 1000, 10 min at 2000
    assert means[1].coverage == 1.0


def test_unavailable_counts_as_a_gap_and_thin_slots_give_no_value() -> None:
    states = [item(-5, "unavailable"), item(10, "600")]  # nothing until 10:10
    means = slot_means(states, T0, T0 + timedelta(minutes=30))
    assert means[0].value is None  # 5 of 15 minutes covered: below half
    assert means[0].coverage == round(5 / 15, 4)
    assert means[1].value == 600.0 and means[1].coverage == 1.0


def test_a_slot_with_no_history_at_all_is_empty() -> None:
    means = slot_means([], T0, T0 + timedelta(minutes=15))
    assert means == [means[0]] and means[0].value is None and means[0].coverage == 0.0


def test_many_changes_inside_one_slot_are_time_weighted() -> None:
    states = [item(0, "0")] + [item(m, str(100 * m)) for m in range(1, 15)]  # ramps 100 W per minute
    [mean] = slot_means(states, T0, T0 + timedelta(minutes=15))
    assert mean.value is not None
    # the minute-long steps 0, 100, …, 1400 W average to 700 W
    assert abs(mean.value - 700.0) < 1e-6
    assert mean.coverage == 1.0
