"""Sofar passive-mode control from the EMHASS plan, as a pure decision function.

This mirrors the Home Assistant automation "EMHASS: Consolidated Inverter Control" rule for rule: P_grid picks
the branch (importing above 100 W, exporting below -100 W, otherwise neutral), P_batt picks the mode (charging
below -100 W, discharging above 100 W, otherwise idle), and when exporting with an idle battery the export price
decides between exporting the PV and keeping it. Every combination maps to a mode, so EMHASS Lens can run it in
dry run and show, slot by slot, whether it agrees with what the automation did. Sign conventions are EMHASS's:
P_batt > 0 discharges the battery, P_grid > 0 imports from the grid.

One deliberate difference: the automation writes the price's feed-in limit every slot, and every press of the
feed-in button is an EEPROM write. Here the limit is only written when something can reach the grid in the slot
(the plan exports, curtails PV, or has PV to spare with the battery nearly full); otherwise it is left as it is.
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
    soc: float | None = None  # 0…1, the plan's state of charge at the slot's end


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
    feedin_max_w: int  # the limit for the slot's export price
    feedin_why: str
    notes: list[str] = field(default_factory=list)
    feedin_needed: bool = True  # False: nothing can reach the grid, so the limit is left as it is

    @property
    def feedin_target(self) -> int | None:
        """The feed-in limit to write and judge; None leaves it as it is."""
        return self.feedin_max_w if self.feedin_needed else None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def round100(value: float) -> int:
    """Jinja's round(0) (Python's round, half to even) on value/100, times 100."""
    return int(round(value / 100) * 100)


_round100 = round100


def feedin_need(v: PlanValues, full_soc: float) -> tuple[bool, str]:
    """Whether the feed-in limit changes anything in this slot, and why. Spare PV is what the PV gives beyond the
    house (deferrable loads included): -(P_batt + P_grid). Without a planned export or curtailment, spare PV only
    reaches the grid when the battery can't take it; below `full_soc` it can (an unknown SOC counts as full)."""
    spare = -(v.p_batt + v.p_grid)
    if v.p_grid < -BAND_W:
        return True, f"the plan exports {-v.p_grid:.0f} W"
    if v.p_pv_curtailment > 0:
        return True, f"the plan curtails {v.p_pv_curtailment:.0f} W of PV"
    if spare <= BAND_W:
        house = v.p_pv - v.p_pv_curtailment + v.p_batt + v.p_grid
        return False, f"no PV to spare (PV {v.p_pv:.0f} W, house {house:.0f} W)"
    if v.soc is None:
        return True, f"{spare:.0f} W of PV to spare and the battery's state of charge is unknown"
    if v.soc >= full_soc:
        return True, f"{spare:.0f} W of PV to spare with the battery nearly full ({v.soc:.0%})"
    return False, f"the battery takes the spare {spare:.0f} W ({v.soc:.0%}, below {full_soc:.0%})"


def decide(v: PlanValues, limits: InverterLimits, no_export_at_or_below: float | None) -> Decision:
    """`no_export_at_or_below` (Settings → EMHASS → MPC) blocks export in cheap slots; None never blocks."""
    g, b, pv, c = v.p_grid, v.p_batt, v.p_pv, v.p_pv_curtailment
    threshold = no_export_at_or_below
    notes: list[str] = []
    if v.export_price is None:
        price = 0.0
        if threshold is not None:
            notes.append("export price unknown; treated as 0 like the automation")
    else:
        price = v.export_price
    cheap = threshold is not None and price <= threshold
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
            why = (
                "exporting, battery idle: export the PV"
                if threshold is None
                else f"exporting, battery idle, price {price:.4f} €/kWh above {threshold}: export the PV"
            )
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
        feedin, feedin_why = limits.export_max_w, "export allowed" if threshold is not None else "export never blocked"
    needed, need_why = feedin_need(v, limits.battery_full_soc_pct / 100)
    feedin_why += f"; written: {need_why}" if needed else f"; left as it is: {need_why}"
    label = LABELS[rule]
    return Decision(rule, label, f"{why} ({vals})", Targets(label, grid, bmax, bmin), feedin, feedin_why, notes, needed)


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
    """Field-by-field agreement between a decision and what the entities show (the feed-in only where it's written)."""
    return compare_targets(decision.targets, decision.feedin_target, observed)
