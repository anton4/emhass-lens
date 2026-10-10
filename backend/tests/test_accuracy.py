"""Which plan a past slot is compared with, and the error statistics (domain/accuracy.py)."""

import math
from datetime import UTC, datetime, timedelta

from emhass_lens.domain.accuracy import accuracy, pick_snapshot, sign_hint

T0 = datetime(2026, 10, 9, 10, 0, tzinfo=UTC)
SLOT = timedelta(minutes=15)


def test_the_plan_in_force_is_the_newest_one_made_at_or_before_the_slot() -> None:
    snapshots = [(1, T0 - timedelta(minutes=2)), (2, T0 + timedelta(minutes=13)), (3, T0 + timedelta(minutes=28))]
    slots = [T0 - SLOT, T0, T0 + SLOT, T0 + 2 * SLOT, T0 + 5 * SLOT]
    assert pick_snapshot(snapshots, slots, timedelta(0)) == {
        T0 - SLOT: None,  # before the first plan
        T0: 1,
        T0 + SLOT: 2,
        T0 + 2 * SLOT: 3,
        T0 + 5 * SLOT: 3,  # the newest plan keeps counting until a newer one arrives
    }


def test_a_look_ahead_takes_the_plan_from_that_long_before_the_slot() -> None:
    snapshots = [(1, T0 - timedelta(minutes=2)), (2, T0 + timedelta(minutes=13)), (3, T0 + timedelta(minutes=28))]
    slots = [T0 + 2 * SLOT, T0 + 4 * SLOT]
    picked = pick_snapshot(snapshots, slots, lead=4 * SLOT)  # one hour ahead
    assert picked[T0 + 2 * SLOT] is None  # nothing was made an hour before 10:30
    assert picked[T0 + 4 * SLOT] == 1  # 11:00 minus 1 h = 10:00: plan 1 (09:58) is the newest by then


def test_accuracy_statistics() -> None:
    acc = accuracy([(1000.0, 900.0), (2000.0, 2200.0), (None, 5.0), (300.0, None)])
    assert acc.n == 2 and acc.coverage == 0.5
    assert acc.mae == 150.0
    assert acc.bias == -50.0  # the plan expected less than happened
    assert acc.rmse is not None and math.isclose(acc.rmse, math.sqrt((100**2 + 200**2) / 2))
    assert acc.mape is None


def test_mape_only_when_asked_and_above_the_floor() -> None:
    acc = accuracy([(110.0, 100.0), (50.0, 10.0)], mape=True, mape_floor=50.0)
    assert acc.mape == 10.0  # the 10 W slot is below the floor and left out
    assert accuracy([], mape=True).n == 0


def test_sign_hint_flags_a_sensor_that_moves_against_the_plan() -> None:
    planned = [math.sin(i / 7) * 1000 for i in range(96)]
    against = [(p, -p + 50) for p in planned]
    along = [(p, p * 0.8 + 30) for p in planned]
    assert sign_hint(against)
    assert not sign_hint(along)
    assert not sign_hint(against[:10])  # too few slots to say
    assert not sign_hint([(1.0, 1.0)] * 60)  # no variance, no opinion
