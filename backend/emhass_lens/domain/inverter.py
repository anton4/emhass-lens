"""Sofar passive-mode control from the EMHASS plan, as a pure decision function.

This mirrors the Home Assistant automation "EMHASS: Consolidated Inverter Control" rule for rule: P_grid picks
the branch (importing above 100 W, exporting below -100 W, otherwise neutral), P_batt picks the mode (charging
below -100 W, discharging above 100 W, otherwise idle), and when exporting with an idle battery the export price
decides between exporting the PV and keeping it. Every combination maps to a mode, so EMHASS Lens can run it in
dry run and show, slot by slot, whether it agrees with what the automation did. Sign conventions are EMHASS's:
P_batt > 0 discharges the battery, P_grid > 0 imports from the grid.
"""

from dataclasses import asdict, dataclass, field
from typing import Any

from emhass_lens.settings.model import InverterLimits

BAND_W = 100  # the automation's neutral band for P_grid and idle band for P_batt

LABELS = {
    "force_charge": "Force charge",
    "use_bat_import": "Self-use battery or PV",
    "use_only_grid": "Use only grid power",
    "charge_export": "Charge battery and export some to grid",
    "force_discharge": "Force discharge",
    "self_use_pv_export": "Self-use PV and export excess to grid",
    "self_use": "Self-use battery or PV",
    "self_use_restrict": "Self-use battery or PV, restrict export to grid",
}


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
    rule: str  # the automation's mode name, e.g. "force_charge"
    label: str
    why: str
    targets: Targets | None  # always set since the template automation; None only in old run artifacts
    feedin_max_w: int
    feedin_why: str
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def round100(value: float) -> int:
    """Jinja's round(0) (Python's round, half to even) on value/100, times 100."""
    return int(round(value / 100) * 100)


_round100 = round100


def decide(v: PlanValues, limits: InverterLimits) -> Decision:
    g, b, pv, c = v.p_grid, v.p_batt, v.p_pv, v.p_pv_curtailment
    threshold = limits.low_export_price
    notes: list[str] = []
    if v.export_price is None:
        price = 0.0
        notes.append("export price unknown; treated as 0 like the automation")
    else:
        price = v.export_price
    cheap = price <= threshold
    vals = f"P_grid {g:.0f} W, P_batt {b:.0f} W, P_PV {pv:.0f} W, curtailment {c:.0f} W"
    bmax, bmin = limits.battery_max_w, limits.battery_min_w

    if g > BAND_W:  # importing
        if b < -BAND_W:
            grid = (
                limits.grid_import_max_w
                if g > limits.force_charge_grid_cap_above_w
                else _round100(g) + limits.force_charge_grid_margin_w
            )
            rule, why = "force_charge", f"importing and charging the battery; grid target {grid} W"
            bmin = limits.force_charge_battery_min_w
        elif b > BAND_W:
            rule, why, grid = "use_bat_import", "importing and discharging (use the battery, import the rest)", 0
        else:
            rule, why, grid = "use_only_grid", "importing, battery idle", 0
            bmin = 0
    elif g < -BAND_W:  # exporting
        if b < -BAND_W:
            rule, why, grid = "charge_export", "exporting while charging the battery", 0
        elif b > BAND_W:
            grid = _round100(g)
            rule, why = "force_discharge", f"exporting from the battery; grid target {grid} W"
        elif not cheap:
            rule, grid = "self_use_pv_export", 0
            why = f"exporting, battery idle, price {price:.4f} €/kWh above {threshold}: export the PV"
            bmax, bmin = 0, limits.export_only_battery_min_w
        else:
            rule, grid = "self_use", 0
            why = f"exporting, battery idle, but the price {price:.4f} €/kWh is at or below {threshold}: keep the PV"
    elif c > 0:  # neutral
        rule, why, grid = "self_use_restrict", "grid neutral and PV is curtailed", 0
    else:
        rule, why, grid = "self_use", "grid neutral, no curtailment", 0

    if cheap:
        feedin, feedin_why = 0, f"export price {price:.4f} €/kWh is at or below {threshold}"
    else:
        feedin, feedin_why = limits.export_max_w, "export allowed"
    label = LABELS[rule]
    return Decision(rule, label, f"{why} ({vals})", Targets(label, grid, bmax, bmin), feedin, feedin_why, notes)


@dataclass(frozen=True)
class Observed:
    """What the inverter entities show (after the automation ran, or after we applied)."""

    state: str | None
    grid_power_w: float | None
    battery_max_w: float | None
    battery_min_w: float | None
    feedin_max_w: float | None


def compare_targets(targets: Targets | None, feedin_w: int | None, observed: Observed) -> dict[str, Any]:
    """Field-by-field agreement between targets (None: not judged) and what the entities show."""
    rows = []
    if targets is not None:
        for name, want, got in (
            ("state", targets.state, observed.state),
            ("grid_power_w", targets.grid_power_w, observed.grid_power_w),
            ("battery_max_w", targets.battery_max_w, observed.battery_max_w),
            ("battery_min_w", targets.battery_min_w, observed.battery_min_w),
        ):
            same = (want == got) if isinstance(want, str) else (got is not None and abs(float(got) - want) < 0.5)
            rows.append({"field": name, "decided": want, "observed": got, "same": same})
    if feedin_w is not None:
        same_feedin = observed.feedin_max_w is not None and abs(observed.feedin_max_w - feedin_w) < 0.5
        rows.append(
            {"field": "feedin_max_w", "decided": feedin_w, "observed": observed.feedin_max_w, "same": same_feedin}
        )
    return {"agree": all(r["same"] for r in rows), "fields": rows}


def compare(decision: Decision, observed: Observed) -> dict[str, Any]:
    """Field-by-field agreement between a decision and what the entities show."""
    return compare_targets(decision.targets, decision.feedin_max_w, observed)
