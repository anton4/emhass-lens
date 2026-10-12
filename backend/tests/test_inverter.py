"""The inverter rules must match the HA automation 'EMHASS: Consolidated Inverter Control' exactly."""

import pytest

from emhass_lens.domain.inverter import Observed, PlanValues, Targets, compare, decide
from emhass_lens.settings.model import InverterLimits

L = InverterLimits(force_charge_at_import_max=False)  # the automation's Force charge grid target
LOW = 0.03  # Settings → EMHASS → MPC "No export at or below", the automation's threshold


def v(
    g: float, b: float, pv: float = 0.0, c: float = 0.0, price: float | None = 0.05, soc: float | None = None
) -> PlanValues:
    return PlanValues(p_batt=b, p_grid=g, p_pv=pv, p_pv_curtailment=c, export_price=price, soc=soc)


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


@pytest.mark.parametrize(
    "values",
    [
        v(12685.32, -10638.3),  # run 2791: above the cap, the import max either way
        v(3795.27, -3063.52),  # run 2803: the automation's rule gives 4800 W, which pressed the apply button again
        v(101, -101),
    ],
)
def test_force_charge_holds_the_import_max_by_default(values) -> None:
    d = decide(values, InverterLimits(), LOW)
    assert d.targets == Targets("Force charge", 18800, 20000, -3000)
    assert "the import max: the battery limits its own charge" in d.why


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


@pytest.mark.parametrize(
    ("values", "needed", "why"),
    [
        # run 1817: importing at 08:15 with little PV, the battery at 73 %
        (v(563, 87, pv=307, price=0.0229, soc=0.73), False, "left as it is: no PV to spare (PV 307 W, house 957 W)"),
        (v(-3000, 6000, price=0.05, soc=0.6), True, "written: the plan exports 3000 W"),
        (v(0, 0, pv=5000, c=400, price=0.02, soc=1.0), True, "written: the plan curtails 400 W of PV"),
        (v(0, -3000, pv=4500, price=0.02, soc=0.7), False, "left as it is: the battery takes the spare 3000 W (70%"),
        (v(0, -3000, pv=4500, price=0.02, soc=0.95), True, "written: 3000 W of PV to spare with the battery nearly"),
        (v(0, -3000, pv=4500, price=0.02), True, "state of charge is unknown"),
        (v(3000, -2500, price=0.02, soc=0.97), False, "no PV to spare"),  # charging from the grid
        (v(50, -120, pv=1570, price=0.02, soc=0.95), False, "no PV to spare"),  # 70 W spare is within the band
    ],
)
def test_the_feedin_limit_is_only_written_when_something_can_reach_the_grid(values, needed, why) -> None:
    d = decide(values, L, LOW)
    assert d.feedin_needed is needed
    assert why in d.feedin_why
    assert d.feedin_target == (d.feedin_max_w if needed else None)


def test_the_nearly_full_threshold_is_a_setting() -> None:
    spare = v(0, -3000, pv=4500, price=0.02, soc=0.85)
    assert decide(spare, L, LOW).feedin_needed is False  # default 90 %
    assert decide(spare, InverterLimits(battery_full_soc_pct=80), LOW).feedin_needed is True


def test_a_feedin_limit_that_isnt_written_isnt_judged() -> None:
    d = decide(v(563, 87, pv=307, price=0.0229, soc=0.73), L, LOW)
    assert d.feedin_max_w == 0 and d.feedin_needed is False
    result = compare(d, Observed("Use only grid power", 0.0, 20000.0, 0.0, 15500.0))
    assert result["agree"] is True
    assert "feedin_max_w" not in [f["field"] for f in result["fields"]]


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
