"""The charger rules must match the HA automation 'EV Charging: Combined EMHASS & Excess Solar (Modbus)'."""

from datetime import UTC, datetime, timedelta

import pytest

from emhass_lens.domain.charger import (
    ChargerInputs,
    ChargerObserved,
    SocTracker,
    compare,
    decide,
    derive,
    emhass_charger_current,
    soc_stop_at,
    soc_stop_due,
    track_soc,
)
from emhass_lens.settings.model import ChargerLimits

L = ChargerLimits()
NOW = datetime(2026, 10, 9, 11, 13, tzinfo=UTC)
FRESH = NOW - timedelta(seconds=30)
STALE = NOW - timedelta(seconds=700)


def inp(**kw) -> ChargerInputs:
    base: dict = {
        "charge_mode": "EMHASS",
        "state_raw": 4,
        "current_limit_a": 6.0,
        "soc": 50.0,
        "target_soc": 80.0,
        "p_deferrable0_w": 5520.0,
        "solar_limit_a": 16,
        "pv_actual_w": 0.0,
        "pv_actual_updated": FRESH,
        "pv_potential_w": 0.0,
        "pv_potential_updated": FRESH,
        "house_load_w": 500.0,
    }
    base.update(kw)
    return ChargerInputs(**base)


@pytest.mark.parametrize(
    ("inputs", "rule", "target", "notify"),
    [
        # EMHASS mode
        (inp(), "emhass_adjust", 8, None),
        (inp(current_limit_a=8), "none", None, None),
        (inp(p_deferrable0_w=0), "emhass_pause", 0, "EV paused charging (EMHASS)"),
        (inp(p_deferrable0_w=0, current_limit_a=0), "emhass_pause", 0, "EV paused charging (EMHASS)"),
        (inp(p_deferrable0_w=1), "none", None, None),
        (inp(p_deferrable0_w=1.01, current_limit_a=6), "none", None, None),  # 1.01 W is 6 A, already set
        (inp(p_deferrable0_w=1.01, current_limit_a=7), "emhass_adjust", 6, None),
        (inp(state_raw=1), "emhass_start", 8, "EMHASS started EV at 8A"),
        (inp(state_raw=2), "emhass_start", 8, "EMHASS started EV at 8A"),
        (inp(state_raw=5), "emhass_start", 8, "EMHASS started EV at 8A"),
        (inp(state_raw=1, p_deferrable0_w=0), "none", None, None),
        (inp(state_raw=0), "none", None, None),
        (inp(state_raw=-1), "none", None, None),
        (inp(state_raw=3), "none", None, None),
        (inp(soc=80), "none", None, None),
        (inp(soc=79.9), "emhass_adjust", 8, None),
        (inp(target_soc=None, soc=99), "emhass_adjust", 8, None),  # unreadable target counts as 100 in the gates
        (inp(p_deferrable0_w=None), "none", None, None),
        (inp(charge_mode="Manual"), "none", None, None),
        (inp(charge_mode=None), "none", None, None),
        # Excess Solar mode
        (
            inp(charge_mode="Excess Solar", state_raw=1, pv_actual_w=8000, house_load_w=1000),
            "solar_start",
            10,
            "Excess Solar started/resumed EV at 10A",
        ),
        (
            inp(charge_mode="Excess Solar", state_raw=4, current_limit_a=8, pv_actual_w=8000, house_load_w=6520),
            "solar_adjust",
            10,
            None,
        ),
        (
            inp(charge_mode="Excess Solar", state_raw=4, current_limit_a=10, pv_actual_w=8000, house_load_w=9000),
            "solar_adjust",
            8,
            None,
        ),
        (
            inp(charge_mode="Excess Solar", state_raw=4, current_limit_a=10, pv_actual_w=7000, house_load_w=1100),
            "none",
            None,
            None,
        ),
        (
            inp(charge_mode="Excess Solar", state_raw=4, current_limit_a=10, pv_actual_w=2000, house_load_w=7900),
            "solar_pause",
            0,
            "EV paused charging (Not enough excess solar)",
        ),
        (inp(charge_mode="Excess Solar", state_raw=1, pv_actual_w=2000, house_load_w=1000), "none", None, None),
        (
            inp(charge_mode="Excess Solar", state_raw=1, pv_actual_w=20000, house_load_w=0),
            "solar_start",
            16,
            "Excess Solar started/resumed EV at 16A",
        ),
        (
            inp(charge_mode="Excess Solar", state_raw=1, pv_actual_w=0, pv_potential_w=8000, house_load_w=1000),
            "solar_start",
            10,
            "Excess Solar started/resumed EV at 10A",
        ),
        (
            inp(charge_mode="Excess Solar", state_raw=1, pv_actual_w=6500, pv_potential_w=8000, house_load_w=1000),
            "solar_start",
            7,
            "Excess Solar started/resumed EV at 7A",
        ),
        # stale PV never raises the current: the target is clamped to the current limit
        (
            inp(
                charge_mode="Excess Solar",
                state_raw=4,
                current_limit_a=8,
                pv_actual_w=10000,
                house_load_w=6520,
                pv_actual_updated=STALE,
            ),
            "none",
            None,
            None,
        ),
        (
            inp(
                charge_mode="Excess Solar",
                state_raw=1,
                current_limit_a=8,
                pv_actual_w=10000,
                house_load_w=1000,
                pv_actual_updated=STALE,
            ),
            "solar_start",
            8,
            "Excess Solar started/resumed EV at 8A",
        ),
        (
            inp(
                charge_mode="Excess Solar",
                state_raw=4,
                current_limit_a=10,
                pv_actual_w=5000,
                house_load_w=7900,
                pv_actual_updated=STALE,
            ),
            "solar_pause",
            0,
            "EV paused charging (Not enough excess solar)",
        ),
        (
            inp(
                charge_mode="Excess Solar",
                state_raw=1,
                current_limit_a=8,
                pv_actual_w=10000,
                house_load_w=1000,
                pv_actual_updated=None,
            ),
            "solar_start",
            8,
            "Excess Solar started/resumed EV at 8A",
        ),
    ],
)
def test_rules_match_the_automation(inputs, rule, target, notify) -> None:
    d = decide(inputs, NOW, L, soc_due=False)
    assert d.rule == rule, d.why
    assert d.target_current_a == target
    assert d.notify == notify


def test_emhass_current_is_p_over_690_clamped_and_rounded_half_to_even() -> None:
    assert emhass_charger_current(1000, 16, L) == 6
    assert emhass_charger_current(20000, 16, L) == 16
    assert emhass_charger_current(20000, 10, L) == 10
    assert emhass_charger_current(5175, 16, L) == 8  # 7.5 -> 8
    assert emhass_charger_current(5865, 16, L) == 8  # 8.5 -> 8
    assert emhass_charger_current(4830, 16, L) == 7


def test_state_5_counts_the_commanded_current_as_the_chargers_own_load() -> None:
    paused = derive(
        inp(charge_mode="Excess Solar", state_raw=5, current_limit_a=8, pv_actual_w=8000, house_load_w=6520), NOW, L
    )
    assert paused.charger_commanded_w == 8 * 690 and paused.other_load_w == 1000 and paused.solar_target_a == 10
    plugged = derive(
        inp(charge_mode="Excess Solar", state_raw=1, current_limit_a=8, pv_actual_w=8000, house_load_w=6520), NOW, L
    )
    assert plugged.charger_commanded_w == 0 and plugged.other_load_w == 6520 and plugged.solar_target_a == 0
    assert derive(inp(pv_actual_w=100, house_load_w=3000), NOW, L).solar_target_a == 0  # negative surplus
    assert derive(inp(pv_actual_updated=None), NOW, L).pv_age_s == 9999


def test_the_soc_stop_fires_once_after_the_holding_time() -> None:
    t = SocTracker()
    t = track_soc(t, inp(soc=85), NOW)
    assert t.since == NOW and not t.fired
    assert not soc_stop_due(t, NOW + timedelta(seconds=299), L.soc_for_s)
    assert soc_stop_due(t, NOW + timedelta(seconds=300), L.soc_for_s)
    assert soc_stop_at(t, L.soc_for_s) == NOW + timedelta(seconds=300)
    later = NOW + timedelta(seconds=400)
    assert track_soc(t, inp(soc=86), later).since == NOW  # the clock keeps its start
    fired = SocTracker(since=NOW, fired=True)
    assert not soc_stop_due(fired, later, L.soc_for_s) and soc_stop_at(fired, L.soc_for_s) is None
    assert track_soc(fired, inp(soc=70), later) == SocTracker()  # below the target: reset
    assert track_soc(SocTracker(), inp(soc=5, target_soc=None), NOW).since == NOW  # unreadable target counts as 0


def test_the_soc_stop_wins_over_any_mode() -> None:
    d = decide(inp(charge_mode="Manual", state_raw=0, soc=85), NOW, L, soc_due=True)
    assert d.rule == "soc_limit" and d.action == "stop_soc" and d.target_current_a == 0
    assert d.notify == "EV Target SoC reached. Charging disabled and mode set to Manual."
    assert decide(inp(soc=85), NOW, L, soc_due=False).rule == "none"  # at the target but not yet due


def test_compare_judges_the_limit_and_the_target_soc_only() -> None:
    d = decide(inp(state_raw=1), NOW, L, soc_due=False)
    assert compare(d, ChargerObserved(8.0, 1, 80.0))["agree"] is True  # the state is reported, not judged
    assert compare(d, ChargerObserved(8.0, 1, 80.0))["charging_state"] == 1
    assert compare(d, ChargerObserved(6.0, 4, 80.0))["agree"] is False
    stop = decide(inp(), NOW, L, soc_due=True)
    assert compare(stop, ChargerObserved(0.0, 1, 100.0))["agree"] is True
    assert [f["field"] for f in compare(stop, ChargerObserved(0.0, 1, 80.0))["fields"] if not f["same"]] == [
        "target_soc"
    ]


def test_numbers_show_what_the_decision_was_made_from() -> None:
    from emhass_lens.domain.charger import numbers

    solar = inp(charge_mode="Excess Solar", current_limit_a=10.0, pv_actual_w=10500.0, house_load_w=8400.0)
    decision = decide(solar, NOW, L, False)
    assert (decision.rule, decision.target_current_a) == ("solar_adjust", 13)
    # house 8.4 kW includes the charger's 10 A × 690 W = 6.9 kW: other load 1.5 kW, surplus 9.0 kW
    assert numbers(decision, solar) == (
        "was 10 A, PV 10.5 kW (actual), house load 8.4 kW (charger 6.9 kW of it), surplus 9.0 kW"
    )
    old = inp(charge_mode="Excess Solar", pv_actual_w=3000.0, pv_actual_updated=NOW - timedelta(minutes=12))
    assert "PV 3.0 kW (actual, 12 min old)" in numbers(decide(old, NOW, L, False), old)
    emhass = inp(state_raw=1, current_limit_a=0.0)
    assert numbers(decide(emhass, NOW, L, False), emhass) == "was 0 A, plan 5.5 kW"
    full = inp(soc=85.0, current_limit_a=8.0)
    assert numbers(decide(full, NOW, L, True), full) == "was 8 A, car 85 %, target 80 %"
