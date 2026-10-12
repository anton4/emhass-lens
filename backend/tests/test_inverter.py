"""The inverter rules must match the HA automation 'EMHASS: Consolidated Inverter Control' exactly."""

import pytest

from emhass_lens.domain.inverter import BRANCHES, Observed, PlanValues, Targets, battery_cap, compare, decide
from emhass_lens.settings.model import InverterLimits

# the automation's Force charge grid target, and grid 0 W with the full window when importing + discharging and
# exporting + charging
L = InverterLimits(force_charge_at_import_max=False, cap_discharge_at_plan=False, cap_charge_at_plan=False)
LOW = 0.03  # Settings → EMHASS → MPC "No export at or below", the automation's threshold


def v(
    g: float, b: float, pv: float = 0.0, c: float = 0.0, price: float | None = 0.05, soc: float | None = None
) -> PlanValues:
    return PlanValues(p_batt=b, p_grid=g, p_pv=pv, p_pv_curtailment=c, export_price=price, soc=soc)


@pytest.mark.parametrize(
    ("values", "rule", "state", "grid", "bmax", "bmin"),
    [
        # importing (P_grid > 100 W)
        (v(4560, -6000), "force_charge", "Force charge", 5600, 20000, -20000),
        (v(9500, -15000), "force_charge", "Force charge", 18800, 20000, -20000),
        (v(9000, -500), "force_charge", "Force charge", 10000, 20000, -20000),  # 9000 is not above the cap
        (v(101, -101), "force_charge", "Force charge", 1100, 20000, -20000),
        (v(3000, 2000), "use_bat_import", "Self-use battery or PV", 0, 20000, -20000),
        (v(2500, 0), "use_only_grid", "Use only grid power", 0, 20000, 0),
        (v(2500, 100), "use_only_grid", "Use only grid power", 0, 20000, 0),  # the idle band is inclusive
        (v(2500, -100), "use_only_grid", "Use only grid power", 0, 20000, 0),
        # exporting (P_grid < -100 W)
        (v(-2000, -3000, pv=6000), "charge_export", "Charge battery and export some to grid", 0, 20000, -20000),
        (v(-15500, 17000), "force_discharge", "Force discharge", -15500, 20000, -20000),
        (v(-4449, 6000), "force_discharge", "Force discharge", -4400, 20000, -20000),
        (v(-101, 101), "force_discharge", "Force discharge", -100, 20000, -20000),
        (v(-3000, 0, pv=5000, price=0.05), "self_use_pv_export", "Self-use PV and export excess to grid", 0, 0, -20000),
        (v(-3000, 50, price=0.05), "self_use_pv_export", "Self-use PV and export excess to grid", 0, 0, -20000),
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
    assert d.targets == Targets("Force charge", 18800, 20000, -20000)
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


# runs 3267 and 3281: after a Kratt sell session the limit was 3000 W and 3800 W, the plan's spare PV 2770 W and 1008 W
RUN_3267 = v(0, -2770.09, pv=3867, price=0.13987, soc=0.9032910767)
RUN_3281 = v(0, -1008.33, pv=2664, price=0.1414, soc=0.9032910767)


def held(feedin: float | None) -> Observed:
    return Observed("Self-use battery or PV", 0.0, 20000.0, -20000.0, feedin)


@pytest.mark.parametrize(
    ("values", "current", "feedin", "floor", "why"),
    [
        (RUN_3267, 3000.0, 3000, 2800, "kept: 3000 W is at least the 2800 W that can reach the grid (2770 W of PV"),
        (RUN_3281, 3800.0, 3800, 1100, "kept: 3800 W is at least the 1100 W"),
        (RUN_3267, 2000.0, 15500, 2800, "written: 2770 W of PV to spare"),  # below what can reach the grid
        (RUN_3267, 16000.0, 15500, 2800, "written:"),  # above the export max
        (RUN_3267, None, 15500, 2800, "written:"),  # a drift correction: the plan's own
        (v(-5000, 6000, price=0.05), 3000.0, 15500, 5000, "written: the plan exports 5000 W"),
        (v(-5000, 6000, price=0.05), 5000.0, 5000, 5000, "kept: 5000 W"),
    ],
)
def test_a_feedin_limit_that_lets_out_what_can_reach_the_grid_is_kept(values, current, feedin, floor, why) -> None:
    d = decide(values, L, LOW, held(current) if current is not None else None)
    assert (d.feedin_max_w, d.feedin_floor_w, d.feedin_range) == (feedin, floor, (floor, 15500))
    assert why in d.feedin_why


@pytest.mark.parametrize(
    ("values", "feedin"),
    [
        (v(0, -2770, pv=3867, price=0.02, soc=0.95), 0),  # cheap: export must stay blocked
        (v(0, 0, pv=5000, c=400, price=0.05, soc=1.0), 15500),  # the plan curtails: the export max exactly
    ],
)
def test_cheap_and_curtailed_slots_keep_an_exact_feedin_limit(values, feedin) -> None:
    d = decide(values, L, LOW, held(3000.0))
    assert (d.feedin_max_w, d.feedin_floor_w, d.feedin_range) == (feedin, None, (feedin, feedin))


def test_any_feedin_limit_in_the_range_compares_as_the_same() -> None:
    d = decide(RUN_3267, L, LOW, held(15500.0))
    assert d.feedin_max_w == 15500 and d.feedin_range == (2800, 15500)
    assert compare(d, held(3000.0))["agree"] is True
    differs = compare(d, held(2000.0))
    assert differs["agree"] is False
    assert [f for f in differs["fields"] if not f["same"]] == [
        {"field": "feedin_max_w", "decided": 15500, "observed": 2000.0, "same": False}
    ]


def test_compare_reports_each_field() -> None:
    d = decide(v(4560, -6000), L, LOW)
    same = compare(d, Observed("Force charge", 5600.0, 20000.0, -20000.0, 15500.0))
    assert same["agree"] is True
    differs = compare(d, Observed("Force charge", 5500.0, 20000.0, -20000.0, 0.0))
    assert differs["agree"] is False
    assert [f["field"] for f in differs["fields"] if not f["same"]] == ["grid_power_w", "feedin_max_w"]


def test_an_empty_threshold_never_blocks_export() -> None:
    idle_export = decide(v(-3000, 0, pv=5000, price=0.0), L, None)
    assert idle_export.rule == "self_use_pv_export"
    assert idle_export.feedin_max_w == 15500
    assert idle_export.notes == []
    assert decide(v(-3000, 0, pv=5000, price=None), L, None).feedin_max_w == 15500  # unknown price: not blocked


def test_each_rule_has_its_own_branch() -> None:
    cases = [
        (v(4560, -6000), "force_charge"),
        (v(3000, 2000), "use_bat_import"),
        (v(2500, 0), "use_only_grid"),
        (v(-2000, -3000, pv=6000), "charge_export"),
        (v(-4449, 6000), "force_discharge"),
        (v(-3000, 0, price=0.05), "self_use_pv_export"),
        (v(-3000, 0, price=0.03), "self_use_keep_pv"),
        (v(0, 500, c=300), "self_use_restrict"),
        (v(-50, 800), "self_use"),
    ]
    assert [branch for _, branch in cases] == list(BRANCHES)
    for values, branch in cases:
        d = decide(values, InverterLimits(), LOW)
        assert d.branch == branch, d.why
    # two branches end in the same mode, which is why the rule list needs the branch to tag one row
    assert decide(v(-3000, 0, price=0.03), L, LOW).rule == decide(v(-50, 800), L, LOW).rule == "self_use"


def test_importing_and_discharging_caps_the_discharge_at_the_plan() -> None:
    d = decide(v(2000, 1040), InverterLimits(), LOW)  # the house 3 kW: the battery 1 kW, the grid the rest
    assert d.rule == "use_bat_import"
    assert d.targets == Targets("Self-use battery or PV", 0, 20000, -1300)
    assert (
        "the battery gives at most 1300 W (the plan's 1040 W + 250 W, rounded up to 100 W), the grid the rest" in d.why
    )


def test_exporting_and_charging_caps_the_charge_at_the_plan() -> None:
    d = decide(v(-4000, -3000, pv=8000, price=0.05), InverterLimits(), LOW)
    assert d.rule == "charge_export"
    assert d.targets == Targets("Charge battery and export some to grid", 0, 3300, -20000)
    assert "the battery takes at most 3300 W" in d.why and "the rest is exported" in d.why
    assert d.feedin_target == 15500  # the export can reach the grid


def test_the_charge_isnt_capped_where_export_is_blocked() -> None:
    d = decide(v(-4000, -3000, pv=8000, price=0.02), InverterLimits(), LOW)
    assert d.targets is not None and d.targets.battery_max_w == 20000
    assert "not capped" in d.why
    assert d.feedin_target == 0


def _replay(needs: list[float], limits: InverterLimits) -> tuple[list[int], int]:
    """Back-to-back importing + discharging slots, each decided from the registers the slot before left."""
    caps, current, writes = [], None, 0
    for need in needs:
        held = None if current is None else Observed("Self-use battery or PV", 0.0, 20000.0, float(current), 15500.0)
        d = decide(v(3000, need), limits, LOW, held)
        assert d.targets is not None
        writes += d.targets.battery_min_w != current
        current = d.targets.battery_min_w
        caps.append(-current)
    return caps, writes


def test_a_cap_within_the_slack_is_kept() -> None:
    caps, writes = _replay([1180, 1260, 1150, 1320, 1210], InverterLimits())
    assert caps == [1500] * 5 and writes == 1
    assert _replay([1180, 1260, 1150, 1320, 1210], InverterLimits(battery_cap_slack_w=0))[1] == 5
    # a plan around a fixed step's edge would write every slot
    assert _replay([990, 1010] * 6, InverterLimits())[1] == 1
    kept = decide(v(3000, 1260), InverterLimits(), LOW, Observed(None, 0.0, 20000.0, -1500.0, None))
    assert kept.targets is not None and kept.targets.battery_min_w == -1500
    assert "1500 W (kept: within 500 W above the plan's 1260 W)" in kept.why


def test_a_drift_correction_ignores_the_slack() -> None:
    d = decide(v(3000, 1260), InverterLimits(), LOW, None)
    assert d.targets is not None and d.targets.battery_min_w == -1600


@pytest.mark.parametrize(
    ("need", "current", "slack", "limit", "expected"),
    [
        (1040, None, 500, 20000, (1300, False)),  # the plan + 250 W, rounded up to 100 W
        (1040, 1300.0, 500, 20000, (1300, False)),  # what would be written anyway
        (1260, 1500.0, 500, 20000, (1500, True)),
        (990, 1300.0, 500, 20000, (1300, False)),
        (900, 1500.0, 500, 20000, (1200, False)),  # more than the slack above the plan
        (1460, 1000.0, 500, 20000, (1800, False)),  # below the plan: never kept
        (1040, None, 0, 20000, (1100, False)),  # no slack: rounded up to 100 W
        (1040, 1100.0, 0, 20000, (1100, False)),
        (1040, 1200.0, 0, 20000, (1100, False)),
        (19800, None, 500, 20000, (20000, False)),
        (25000, 20000.0, 500, 20000, (20000, False)),  # never above the configured window
        (5000, None, 500, 3000, (3000, False)),
    ],
)
def test_battery_cap(need, current, slack, limit, expected) -> None:
    assert battery_cap(need, current, slack, limit) == expected


def test_a_cap_is_clamped_to_the_configured_window() -> None:
    d = decide(v(3000, 5000), InverterLimits(battery_min_w=-3000), LOW)
    assert d.targets is not None and d.targets.battery_min_w == -3000
    assert "3000 W (the configured limit; the plan: 5000 W)" in d.why
