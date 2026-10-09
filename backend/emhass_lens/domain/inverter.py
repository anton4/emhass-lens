"""Sofar passive-mode control from the EMHASS plan, as a pure decision function.

This mirrors the Home Assistant automation "EMHASS: Consolidated Inverter Control" rule for rule (same
order, same thresholds), so EMHASS Lens can first run it in dry run and show, slot by slot, whether it
agrees with what the automation did. Sign conventions are EMHASS's: P_batt > 0 discharges the battery,
P_grid > 0 imports from the grid.

The automation's branch "Charge battery and export some to grid" can never match, because "Vahepealne"
above it already matches every case it covers; the order is kept so decisions stay comparable.
"""

from dataclasses import asdict, dataclass, field
from typing import Any

from emhass_lens.settings.model import InverterLimits


@dataclass(frozen=True)
class PlanValues:
    p_batt: float  # W, + discharge
    p_grid: float  # W, + import
    p_pv: float  # W
    p_pv_curtailment: float  # W
    export_price: float | None  # €/kWh for the current slot


@dataclass(frozen=True)
class Targets:
    state: str  # the automation's input_select option
    grid_power_w: int
    battery_max_w: int
    battery_min_w: int


@dataclass(frozen=True)
class Decision:
    rule: str  # rule id, a..i, or "none"
    label: str
    why: str
    targets: Targets | None
    feedin_max_w: int
    feedin_why: str
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _between(value: float, above: float, below: float) -> bool:
    """Home Assistant numeric_state: strictly above and strictly below."""
    return above < value < below


def _round100(value: float) -> int:
    """Jinja's round(0) (Python's round) on value/100, times 100."""
    return int(round(value / 100) * 100)


def decide(v: PlanValues, limits: InverterLimits) -> Decision:
    g, b, pv, c = v.p_grid, v.p_batt, v.p_pv, v.p_pv_curtailment
    full = (limits.battery_max_w, limits.battery_min_w)
    vals = f"P_grid {g:.0f} W, P_batt {b:.0f} W, P_PV {pv:.0f} W, curtailment {c:.0f} W"

    def make(rule: str, label: str, why: str, grid: int, bmax: int, bmin: int) -> tuple[str, str, str, Targets]:
        return rule, label, why, Targets(label, grid, bmax, bmin)

    chosen: tuple[str, str, str, Targets] | None = None
    if _between(g, -100, 1) and c > 0:
        chosen = make("a", "Self-use battery or PV, restrict export to grid", "grid ≈ 0 and PV is curtailed", 0, *full)
    elif _between(g, -100, 1) and _between(c, -1, 1):
        chosen = make("b", "Self-use battery or PV", "grid ≈ 0, no curtailment", 0, *full)
    elif g < -100 and _between(b, -1, 1) and pv > 0:
        chosen = make(
            "c",
            "Self-use PV and export excess to grid",
            "exporting, battery idle, PV producing",
            0,
            0,
            limits.export_only_battery_min_w,
        )
    elif b < -1 and g < -1:
        chosen = make("d", "Vahepealne", "charging the battery while exporting", 0, *full)
    elif g < -101 and pv > 500 and b < -500:  # unreachable: rule d covers it (kept for parity)
        chosen = make("e", "Charge battery and export some to grid", "charging and exporting", 0, *full)
    elif g > 1 and _between(b, -1, 1):
        chosen = make("f", "Use only grid power", "importing, battery idle", 0, limits.battery_max_w, 0)
    elif b < -100 and g > 100:
        target = (
            limits.grid_import_max_w
            if g > limits.force_charge_grid_cap_above_w
            else (_round100(g) + limits.force_charge_grid_margin_w)
        )
        chosen = make(
            "g",
            "Force charge",
            f"charging from the grid; grid target {target} W",
            target,
            limits.battery_max_w,
            limits.force_charge_battery_min_w,
        )
    elif b > 1 and g < -1:
        target = _round100(g)
        chosen = make("h", "Force discharge", f"discharging to the grid; grid target {target} W", target, *full)
    elif g > 100 and b > 100:
        chosen = make(
            "i", "Self-use battery or PV", "discharging and importing (use battery, import the rest)", 0, *full
        )

    price = v.export_price
    if price is not None and price < limits.low_export_price:
        feedin, feedin_why = 0, f"export price {price:.4f} €/kWh is below {limits.low_export_price}"
    elif c > 0 and g < 1:
        feedin, feedin_why = 0, "PV is curtailed and nothing is exported"
    else:
        feedin, feedin_why = limits.export_max_w, "export allowed"

    if chosen is None:
        return Decision("none", "No change", f"no rule matches ({vals})", None, feedin, feedin_why)
    rule, label, why, targets = chosen
    return Decision(rule, label, f"{why} ({vals})", targets, feedin, feedin_why)


@dataclass(frozen=True)
class Observed:
    """What the inverter entities show (after the automation ran, or after we applied)."""

    state: str | None
    grid_power_w: float | None
    battery_max_w: float | None
    battery_min_w: float | None
    feedin_max_w: float | None


def compare(decision: Decision, observed: Observed) -> dict[str, Any]:
    """Field-by-field agreement between a decision and what the entities show."""
    rows = []
    if decision.targets is not None:
        t = decision.targets
        for name, want, got in (
            ("state", t.state, observed.state),
            ("grid_power_w", t.grid_power_w, observed.grid_power_w),
            ("battery_max_w", t.battery_max_w, observed.battery_max_w),
            ("battery_min_w", t.battery_min_w, observed.battery_min_w),
        ):
            same = (want == got) if isinstance(want, str) else (got is not None and abs(float(got) - want) < 0.5)
            rows.append({"field": name, "decided": want, "observed": got, "same": same})
    same_feedin = observed.feedin_max_w is not None and abs(observed.feedin_max_w - decision.feedin_max_w) < 0.5
    rows.append(
        {
            "field": "feedin_max_w",
            "decided": decision.feedin_max_w,
            "observed": observed.feedin_max_w,
            "same": same_feedin,
        }
    )
    return {"agree": all(r["same"] for r in rows), "fields": rows}
