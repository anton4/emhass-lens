"""PV reserved for the EV while it charges from excess solar: the pure rules behind the smaller PV forecast."""

from datetime import UTC, datetime, timedelta

from emhass_lens.domain.charger import ChargerInputs, derive, solar_amps
from emhass_lens.domain.ev_reserve import EvReserve, blocker, house_load_profile, load_by_slot, plan_reserve
from emhass_lens.settings.model import ChargerLimits

LIMITS = ChargerLimits()
T0 = datetime(2026, 10, 9, 11, 0, tzinfo=UTC)


def slots(n: int, start: datetime = T0) -> list[datetime]:
    return [start + timedelta(minutes=15 * i) for i in range(n)]


def test_solar_amps_is_the_controller_rule() -> None:
    assert solar_amps(7500, 16, LIMITS) == 10  # 7500 // 690 = 10
    assert solar_amps(4000, 16, LIMITS) == 0  # 5 A is below the 6 A minimum
    assert solar_amps(20000, 16, LIMITS) == 16  # capped by the maximum-current helper
    assert solar_amps(-500, 16, LIMITS) == 0
    inputs = ChargerInputs(
        charge_mode="Excess Solar",
        state_raw=1,
        current_limit_a=0.0,
        soc=50.0,
        target_soc=80.0,
        p_deferrable0_w=None,
        solar_limit_a=16,
        pv_actual_w=9000.0,
        pv_actual_updated=T0,
        pv_potential_w=0.0,
        pv_potential_updated=T0,
        house_load_w=1500.0,
    )
    assert derive(inputs, T0, LIMITS).solar_target_a == solar_amps(9000 - 1500, 16, LIMITS) == 10


def test_blocker_names_why_the_car_is_not_on_excess_solar() -> None:
    assert blocker("EMHASS", "Excess Solar", 1, 50, 80) == "the charge mode is EMHASS, not Excess Solar"
    assert blocker(None, "Excess Solar", 1, 50, 80) == "the charge mode is unknown, not Excess Solar"
    assert blocker("Excess Solar", "Excess Solar", -1, 50, 80) == "the charger's state is unknown"
    assert blocker("Excess Solar", "Excess Solar", 0, 50, 80) == "the car is unplugged"
    assert blocker("Excess Solar", "Excess Solar", 4, 85, 80) == "the car is at 85 %, target 80 %"
    assert blocker("Excess Solar", "Excess Solar", 1, 99, None) is None  # no target reads as 100
    assert blocker("Excess Solar", "Excess Solar", 1, 100, None) == "the car is at 100 %, target 100 %"
    assert blocker("Excess Solar", "Excess Solar", 5, 50, 80) is None


def test_load_by_slot_reads_the_plan_rows_in_utc() -> None:
    plan = [
        {"timestamp": "2026-10-09T14:00:00+03:00", "P_Load": 1200},
        {"timestamp": "2026-10-09T11:15:00Z", "P_Load": "1300"},
        {"timestamp": "2026-10-09T11:30:00Z", "P_Load": None},
        {"P_Load": 999},
    ]
    assert load_by_slot(plan) == {T0: 1200.0, T0 + timedelta(minutes=15): 1300.0}


def test_house_load_profile_falls_back_to_the_day_before_then_the_mean() -> None:
    day = timedelta(hours=24)
    known = {T0: 1000.0, T0 + timedelta(minutes=15): 2000.0}
    wanted = [T0, T0 + day, T0 + day + timedelta(minutes=15), T0 + 2 * day, T0 + timedelta(hours=5)]
    profile = house_load_profile(known, wanted)
    assert profile[T0] == 1000.0
    assert profile[T0 + day] == 1000.0  # 24 h earlier
    assert profile[T0 + day + timedelta(minutes=15)] == 2000.0
    assert profile[T0 + 2 * day] == 1000.0  # 48 h earlier
    assert profile[T0 + timedelta(hours=5)] == 1500.0  # the mean
    assert house_load_profile({}, wanted) == {}


def reserve(**kw) -> EvReserve:
    starts = slots(8)
    base = {
        "starts": starts,
        "pv_w": [9000.0] * 8,
        "load_w": dict.fromkeys(starts, 1500.0),
        "soc": 50.0,
        "target_soc": 80.0,
        "solar_limit_a": 16,
        "limits": LIMITS,
        "capacity_kwh": 10.0,
    }
    base.update(kw)
    return plan_reserve(**base)


def test_plan_reserve_stops_when_the_car_has_what_it_needs() -> None:
    r = reserve()  # 30 % of 10 kWh = 3 kWh to go; 7500 W surplus -> 10 A = 6900 W a slot = 1725 Wh
    starts = slots(8)
    assert r.active
    assert r.watts == {starts[0]: 6900, starts[1]: 5100}  # the second slot takes only the missing 1275 Wh
    assert r.energy_needed_wh == 3000
    assert round(r.energy_reserved_wh) == 3000
    assert r.until == starts[1]
    assert r.at(starts[0]) == 6900 and r.at(starts[2]) == 0
    assert r.max_w == 6900
    assert r.why == "Excess Solar, car 50 % → 80 %, 3.0 kWh to go"
    assert r.summary()["slots"] == 2 and r.summary()["until"] is not None


def test_plan_reserve_follows_the_minimum_current_the_cap_and_the_load_profile() -> None:
    assert reserve(pv_w=[4000.0] * 8).watts == {}  # 2500 W surplus is 3 A: below 6 A nothing charges
    assert reserve(pv_w=[4000.0] * 8).why.endswith("; no PV surplus in the forecast")
    capped = reserve(pv_w=[30000.0] * 8, load_w=dict.fromkeys(slots(8), 0.0), capacity_kwh=100.0)
    assert set(capped.watts.values()) == {16 * 690}
    partial = reserve(load_w={slots(8)[3]: 1500.0}, capacity_kwh=100.0)  # the plan only knows one slot
    assert list(partial.watts) == [slots(8)[3]]
    assert reserve(target_soc=None, capacity_kwh=1.0).energy_needed_wh == 500  # no target reads as 100 %
    assert reserve(soc=80.0).watts == {} and reserve(soc=80.0).energy_needed_wh == 0


def test_an_inactive_reserve_never_reserves() -> None:
    r = EvReserve(False, "the car is unplugged", watts={T0: 5000.0})
    assert r.at(T0) == 0
    assert r.summary()["active"] is False
