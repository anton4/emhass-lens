"""The inverter rules must match the HA automation 'EMHASS: Consolidated Inverter Control' exactly."""

import pytest

from emhass_lens.domain.inverter import Observed, PlanValues, compare, decide
from emhass_lens.settings.model import InverterLimits

L = InverterLimits()


def v(g: float, b: float, pv: float = 0.0, c: float = 0.0, price: float | None = 0.05) -> PlanValues:
    return PlanValues(p_batt=b, p_grid=g, p_pv=pv, p_pv_curtailment=c, export_price=price)


@pytest.mark.parametrize(
    ("values", "rule", "state", "grid", "bmax", "bmin"),
    [
        (v(0, 500, c=300), "a", "Self-use battery or PV, restrict export to grid", 0, 20000, -20000),
        (v(-50, 800), "b", "Self-use battery or PV", 0, 20000, -20000),
        (v(-3000, 0, pv=5000), "c", "Self-use PV and export excess to grid", 0, 0, -16000),
        (v(-2000, -3000, pv=6000), "d", "Vahepealne", 0, 20000, -20000),
        (v(2500, 0), "f", "Use only grid power", 0, 20000, 0),
        (v(4560, -6000), "g", "Force charge", 5600, 20000, -3000),
        (v(9500, -15000), "g", "Force charge", 18800, 20000, -3000),
        (v(-15500, 17000), "h", "Force discharge", -15500, 20000, -20000),
        (v(-4449, 6000), "h", "Force discharge", -4400, 20000, -20000),
        (v(3000, 2000), "i", "Self-use battery or PV", 0, 20000, -20000),
    ],
)
def test_rules_match_the_automation(values, rule, state, grid, bmax, bmin) -> None:
    d = decide(values, L)
    assert d.rule == rule, d.why
    assert d.targets is not None
    assert (d.targets.state, d.targets.grid_power_w, d.targets.battery_max_w, d.targets.battery_min_w) == (
        state,
        grid,
        bmax,
        bmin,
    )


def test_rule_e_is_unreachable_like_in_the_automation() -> None:
    d = decide(v(-3000, -2000, pv=6000), L)  # meets e's conditions, but d comes first
    assert d.rule == "d"


def test_jinja_round_is_half_to_even() -> None:
    assert decide(v(4450, -6000), L).targets.grid_power_w == 5400  # type: ignore[union-attr]  # 44.5 -> 44
    assert decide(v(4550, -6000), L).targets.grid_power_w == 5600  # type: ignore[union-attr]  # 45.5 -> 46


def test_no_rule_means_no_change() -> None:
    d = decide(v(50, 50), L)  # importing a little, battery discharging a little: nothing matches
    assert d.rule == "none"
    assert d.targets is None


@pytest.mark.parametrize(
    ("values", "feedin"),
    [
        (v(-3000, 0, pv=5000, price=0.015), 0),  # cheap export
        (v(0, 0, c=400, price=0.05), 0),  # curtailing, nothing exported
        (v(-3000, 0, pv=5000, price=0.05), 15500),
        (v(-3000, 0, pv=5000, price=None), 15500),
    ],
)
def test_feedin_limit(values, feedin) -> None:
    assert decide(values, L).feedin_max_w == feedin


def test_compare_reports_each_field() -> None:
    d = decide(v(4560, -6000), L)
    same = compare(d, Observed("Force charge", 5600.0, 20000.0, -3000.0, 15500.0))
    assert same["agree"] is True
    differs = compare(d, Observed("Force charge", 5500.0, 20000.0, -3000.0, 0.0))
    assert differs["agree"] is False
    assert [f["field"] for f in differs["fields"] if not f["same"]] == ["grid_power_w", "feedin_max_w"]
