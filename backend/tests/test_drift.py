"""Drift: seen twice, not right after our own write, and not again and again (domain/drift.py)."""

from datetime import UTC, datetime, timedelta

from emhass_lens.domain.drift import DriftTracker, assess, describe

T0 = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)
GRID = {"grid_power_w": (3000.0, 5600)}


def minutes(n: float) -> datetime:
    return T0 + timedelta(minutes=n)


def test_drift_is_corrected_only_when_seen_twice_and_not_right_after_our_write() -> None:
    t, action = assess(DriftTracker(), minutes(0), {}, None)
    assert action == "ok"
    t, action = assess(t, minutes(1), GRID, last_write_at=minutes(0))
    assert action == "settling"  # 60 s after our own write: Home Assistant may still show the old value
    t, action = assess(t, minutes(3), GRID, last_write_at=minutes(0))
    assert action == "watch"
    t, action = assess(t, minutes(4), {"grid_power_w": (3100.0, 5600)}, last_write_at=minutes(0))
    assert action == "watch"  # a different value: watch again
    t, action = assess(t, minutes(5), {"grid_power_w": (3100.0, 5600)}, last_write_at=minutes(0))
    assert action == "correct" and t.corrections_since(minutes(0)) == 1
    t, action = assess(t, minutes(6), {}, last_write_at=minutes(5))
    assert action == "ok" and t.seen == {}
    t, action = assess(t, minutes(10), GRID, last_write_at=minutes(5))
    t, action = assess(t, minutes(10.1), GRID, last_write_at=minutes(5))
    assert action == "watch"  # seen again only 6 s later: two checks at once don't confirm anything
    t, action = assess(t, minutes(11), GRID, last_write_at=minutes(5))
    assert action == "correct"


def test_something_that_keeps_changing_it_stops_the_corrections_for_an_hour() -> None:
    t = DriftTracker()
    corrected = 0
    for n in range(0, 40, 4):  # the field drifts again after every correction
        t, first = assess(t, minutes(n), GRID, last_write_at=minutes(n - 3))
        t, action = assess(t, minutes(n + 1), GRID, last_write_at=minutes(n - 3))
        assert first == "watch" or t.fighting is not None
        if action == "correct":
            corrected += 1
        if action == "fighting":
            break
    assert corrected == 3
    assert t.fighting is not None and t.fighting["field"] == "grid_power_w" and t.fighting["count"] == 3
    since = t.fighting["since"]
    t, action = assess(t, since + timedelta(minutes=30), GRID, last_write_at=None)
    assert action == "fighting"  # paused: no write
    t, action = assess(t, since + timedelta(minutes=61), {}, last_write_at=None)
    assert action == "ok" and t.fighting is None  # an hour later it tries again


def test_several_fields_and_the_words_for_them() -> None:
    both = {"grid_power_w": (3000.0, 5600), "feedin_max_w": (0.0, 15500)}
    t, action = assess(DriftTracker(), minutes(0), both, None)
    t, action = assess(t, minutes(1), both, None)
    assert action == "correct" and set(t.corrections) == {"grid_power_w", "feedin_max_w"}
    labels = {"grid_power_w": ("grid power", "W"), "feedin_max_w": ("feed-in limit", "W")}
    assert describe(both, labels) == "grid power 3000 W, expected 5600 W; feed-in limit 0 W, expected 15500 W"
    assert describe({"state": ("Self-use", "Force charge")}, {}) == "state Self-use, expected Force charge"
