"""Means and the finer line from recorder history (domain/measure.py)."""

from datetime import UTC, datetime, timedelta

from emhass_lens.domain.measure import (
    Point,
    bucket_means,
    clip_points,
    detail,
    detail_edges,
    numeric,
    pick_step,
    slot_means,
    step_points,
)

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


# --- the finer line -----------------------------------------------------------------------------------------------

A = T0.timestamp()


def test_clip_points_starts_with_the_value_in_force() -> None:
    points = [(A - 50, 1.0), (A + 10, 2.0), (A + 20, None), (A + 70, 3.0)]
    assert clip_points(points, A, A + 60) == [(A, 1.0), (A + 10, 2.0), (A + 20, None)]
    assert clip_points(points, A + 10, A + 15) == [(A + 10, 2.0)]  # a change at the start is the start's value
    assert clip_points(points, A - 100, A - 60) == [(A - 100, None)]  # nothing known yet
    assert step_points([item(-1, "5"), item(0.5, "unknown")], A, A + 60) == [(A, 5.0), (A + 30, None)]


def test_bucket_means_on_uneven_edges_weigh_by_time_and_skip_gaps() -> None:
    points = [(A, 100.0), (A + 10, 300.0), (A + 30, None), (A + 40, 500.0)]
    means = bucket_means(points, [A, A + 20, A + 25, A + 40, A + 100])
    assert means[0] == (200.0, 1.0)  # 10 s at 100 W, 10 s at 300 W
    assert means[1] == (300.0, 1.0)
    assert means[2] == (None, 0.3333)  # 5 of 15 s had a value
    assert means[3] == (500.0, 1.0)  # the last point holds to the end


def test_pick_step_keeps_the_window_within_the_points() -> None:
    assert pick_step(3 * 3600, 1500) == 10
    assert pick_step(6 * 3600, 1500) == 30
    assert pick_step(24 * 3600, 1500) == 60
    assert pick_step(48 * 3600, 1500) == 120
    assert pick_step(48 * 3600, 250) == 900  # the coarsest when nothing fits


def test_detail_edges_break_at_the_commands_without_slivers() -> None:
    start = A + 5  # not on a 10 s multiple
    edges = detail_edges(start, A + 60, 10, [A + 31, A + 31.4, A + 48, A + 100])
    # multiples of 10 s, the 31 s break (31.4 is the same moment) and 48 s; 30 s and 50 s are too close to them
    assert edges == [start, A + 10, A + 20, A + 31, A + 40, A + 48, A + 60]
    assert detail_edges(A, A + 30, 10, [A + 0.5, A + 29.5]) == [A, A + 10, A + 20, A + 30]


def test_detail_gives_every_change_when_they_fit_and_means_when_not() -> None:
    points: list[Point] = [(A + i, float(i % 7)) for i in range(0, 600, 5)]  # a change every 5 s for 10 minutes
    step, raw = detail(points, A, A + 600, 500)
    assert step is None and len(raw) == 120 and raw[:2] == [(A, 0.0), (A + 5, 5.0)]

    step, means = detail(points, A, A + 600, 50, breaks=[A + 123])
    assert step == 30
    starts = [t for t, _ in means]
    assert A + 123 in starts and A + 120 not in starts  # the command's start is a point; 120 s gives way
    assert len(means) <= 50
    assert detail([(A, 1.0), (A + 5, 1.0), (A + 9, 2.0)], A, A + 20, 10) == (None, [(A, 1.0), (A + 9, 2.0)])


def test_reading_in_hours_gives_the_same_line_as_one_read() -> None:
    states = [item(m / 6, str(m * 10)) for m in range(-3, 6 * 60 * 2)]  # every 10 s over 2 hours
    whole = step_points(states, A, A + 7200)
    joined = step_points(states, A, A + 3600) + step_points(states, A + 3600, A + 7200)
    assert detail(joined, A, A + 7200, 100) == detail(whole, A, A + 7200, 100)
    assert bucket_means(joined, [A, A + 7200]) == bucket_means(whole, [A, A + 7200])
