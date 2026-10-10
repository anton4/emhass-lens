"""The inverter rules must match the HA automation 'EMHASS: Consolidated Inverter Control' exactly."""

import pytest

from emhass_lens.domain.inverter import Observed, PlanValues, compare, decide
from emhass_lens.settings.model import InverterLimits

L = InverterLimits()
LOW = 0.03  # Settings → EMHASS → MPC "No export at or below", the automation's threshold


def v(g: float, b: float, pv: float = 0.0, c: float = 0.0, price: float | None = 0.05) -> PlanValues:
    return PlanValues(p_batt=b, p_grid=g, p_pv=pv, p_pv_curtailment=c, export_price=price)


@pytest.mark.parametrize(
    ("values", "rule", "state", "grid", "bmax", "bmin"),
    [
        # importing (P_grid > 100 W)
        (v(4560, -6000), "force_charge", "Force charge", 5600, 20000, -3000),
        (v(9500, -15000), "force_charge", "Force charge", 18800, 20000, -3000),
        (v(9000, -500), "force_charge", "Force charge", 10000, 20000, -3000),  # 9000 is not above the cap
        (v(101, -101), "force_charge", "Force charge", 1100, 20000, -3000),
        (v(3000, 2000), "use_bat_import", "Self-use battery or PV", 0, 20000, -20000),
        (v(2500, 0), "use_only_grid", "Use only grid power", 0, 20000, 0),
        (v(2500, 100), "use_only_grid", "Use only grid power", 0, 20000, 0),  # the idle band is inclusive
        (v(2500, -100), "use_only_grid", "Use only grid power", 0, 20000, 0),
        # exporting (P_grid < -100 W)
        (v(-2000, -3000, pv=6000), "charge_export", "Charge battery and export some to grid", 0, 20000, -20000),
        (v(-15500, 17000), "force_discharge", "Force discharge", -15500, 20000, -20000),
        (v(-4449, 6000), "force_discharge", "Force discharge", -4400, 20000, -20000),
        (v(-101, 101), "force_discharge", "Force discharge", -100, 20000, -20000),
        (v(-3000, 0, pv=5000, price=0.05), "self_use_pv_export", "Self-use PV and export excess to grid", 0, 0, -16000),
        (v(-3000, 50, price=0.05), "self_use_pv_export", "Self-use PV and export excess to grid", 0, 0, -16000),
        (v(-3000, 0, price=0.03), "self_use", "Self-use battery or PV", 0, 20000, -20000),  # not above the threshold
        (v(-3000, 0, price=None), "self_use", "Self-use battery or PV", 0, 20000, -20000),  # unknown counts as 0
        # neutral (-100…100 W)
        (v(0, 500, c=300), "self_use_restrict", "Self-use battery or PV, restrict export to grid", 0, 20000, -20000),
        (v(-100, 6000, c=1), "self_use_restrict", "Self-use battery or PV, restrict export to grid", 0, 20000, -20000),
        (v(-50, 800), "self_use", "Self-use battery or PV", 0, 20000, -20000),
        (v(100, -6000), "self_use", "Self-use battery or PV", 0, 20000, -20000),  # 100 W is still neutral
        (v(50, 50), "self_use", "Self-use battery or PV", 0, 20000, -20000),
    ],
)
def test_rules_match_the_automation(values, rule, state, grid, bmax, bmin) -> None:
    d = decide(values, L, LOW)
    assert d.rule == rule, d.why
    assert d.targets is not None
    assert (d.targets.state, d.targets.grid_power_w, d.targets.battery_max_w, d.targets.battery_min_w) == (
        state,
        grid,
        bmax,
        bmin,
    )


def test_jinja_round_is_half_to_even() -> None:
    assert decide(v(4450, -6000), L, LOW).targets.grid_power_w == 5400  # type: ignore[union-attr]  # 44.5 -> 44
    assert decide(v(4550, -6000), L, LOW).targets.grid_power_w == 5600  # type: ignore[union-attr]  # 45.5 -> 46
    assert decide(v(-4450, 6000), L, LOW).targets.grid_power_w == -4400  # type: ignore[union-attr]
    assert decide(v(-4550, 6000), L, LOW).targets.grid_power_w == -4600  # type: ignore[union-attr]


def test_every_combination_has_targets() -> None:
    for g in (-5000, -100, 0, 100, 5000):
        for b in (-5000, -100, 0, 100, 5000):
            d = decide(v(g, b), L, LOW)
            assert d.rule != "none" and d.targets is not None, (g, b)


def test_unknown_export_price_is_noted() -> None:
    d = decide(v(-3000, 0, price=None), L, LOW)
    assert d.notes == ["export price unknown; treated as 0 like the automation"]
    assert decide(v(-3000, 0, price=0.05), L, LOW).notes == []


@pytest.mark.parametrize(
    ("values", "feedin"),
    [
        (v(-3000, 0, pv=5000, price=0.03), 0),  # at the threshold: blocked
        (v(-3000, 0, pv=5000, price=0.0301), 15500),
        (v(-3000, 0, pv=5000, price=None), 0),  # unknown counts as 0
        (v(0, 0, c=400, price=0.05), 15500),  # curtailment no longer matters
        (v(4560, -6000, price=0.05), 15500),
    ],
)
def test_feedin_limit(values, feedin) -> None:
    assert decide(values, L, LOW).feedin_max_w == feedin


def test_compare_reports_each_field() -> None:
    d = decide(v(4560, -6000), L, LOW)
    same = compare(d, Observed("Force charge", 5600.0, 20000.0, -3000.0, 15500.0))
    assert same["agree"] is True
    differs = compare(d, Observed("Force charge", 5500.0, 20000.0, -3000.0, 0.0))
    assert differs["agree"] is False
    assert [f["field"] for f in differs["fields"] if not f["same"]] == ["grid_power_w", "feedin_max_w"]


def test_an_empty_threshold_never_blocks_export() -> None:
    idle_export = decide(v(-3000, 0, pv=5000, price=0.0), L, None)
    assert idle_export.rule == "self_use_pv_export"
    assert idle_export.feedin_max_w == 15500
    assert idle_export.notes == []
    assert decide(v(-3000, 0, pv=5000, price=None), L, None).feedin_max_w == 15500  # unknown price: not blocked
