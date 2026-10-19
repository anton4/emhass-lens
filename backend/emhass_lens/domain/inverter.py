"""Sofar passive-mode control from the EMHASS plan, as a pure decision function.

This mirrors the Home Assistant automation "EMHASS: Consolidated Inverter Control" rule for rule: P_grid picks
the branch (importing above 100 W, exporting below -100 W, otherwise neutral), P_batt picks the mode (charging
below -100 W, discharging above 100 W, otherwise idle), and when exporting with an idle battery the export price
decides between exporting the PV and keeping it. Every combination maps to a mode, so EMHASS Lens can run it in
dry run and show, slot by slot, whether it agrees with what the automation did. Sign conventions are EMHASS's:
P_batt > 0 discharges the battery, P_grid > 0 imports from the grid.

Two deliberate differences, both because every press of a Sofar button is an EEPROM write:
- The automation writes the price's feed-in limit every slot. Here the limit is only written when something can
  reach the grid in the slot (the plan exports, curtails PV, or has PV to spare with the battery nearly full);
  otherwise it is left as it is. When export is allowed, a limit already at or above what can reach the grid (e.g.
  the one a market sell session left) is kept too.
- The automation's Force charge grid target follows P_grid below a cap, so back-to-back Force charge slots press the
  apply button just to change it. Here Force charge sets the import max by default and the battery limits its own
  charge, so those slots write nothing (`force_charge_at_import_max` off restores the automation's rule).

Two more where the automation's grid target of 0 W doesn't do what the plan says, because the battery then takes all
the slack (each has a setting; off restores the automation's rule):
- Importing while discharging, the plan saves the battery for a dearer slot, but grid 0 W makes it cover the whole
  house. `cap_discharge_at_plan` caps the discharge at the plan's P_batt, and the grid covers the rest.
- Exporting while charging, the plan sells some PV now and fills the battery later, but grid 0 W puts all the surplus
  in the battery. `cap_charge_at_plan` caps the charge at the plan's, and the rest is exported.
A cap is written at the plan plus half of `battery_cap_slack_w` and kept while it stays within the slack above the
plan, so small changes in the plan don't press the apply button.
"""

import math
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

# The rules in the order they are tried, one key each; the mode (`rule`) of self_use_keep_pv is self_use
BRANCHES = (
    "force_charge",
    "use_bat_import",
    "use_only_grid",
    "charge_export",
    "force_discharge",
    "self_use_pv_export",
    "self_use_keep_pv",
    "self_use_restrict",
    "self_use",
)


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
    branch: str = ""  # which of the rules matched (BRANCHES); two of them end in the mode self_use
    feedin_floor_w: int | None = None  # export allowed: any limit from here up to the ceiling serves the slot
    feedin_ceiling_w: int | None = None
    p_batt_w: float | None = None  # the plan's battery power the decision was made from (+ discharge)

    @property
    def feedin_target(self) -> int | None:
        """The feed-in limit to write and judge; None leaves it as it is."""
        return self.feedin_max_w if self.feedin_needed else None

    @property
    def feedin_range(self) -> tuple[int, int] | None:
        """The feed-in limits that serve the slot: from the floor to the export max when export is allowed, exactly
        the target otherwise; None when the limit is left as it is."""
        if not self.feedin_needed:
            return None
        if self.feedin_floor_w is not None and self.feedin_ceiling_w is not None:
            return self.feedin_floor_w, self.feedin_ceiling_w
        return self.feedin_max_w, self.feedin_max_w

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Observed:
    """What the inverter entities show (after the automation ran, or after we applied)."""

    state: str | None
    grid_power_w: float | None
    battery_max_w: float | None
    battery_min_w: float | None
    feedin_max_w: float | None


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


def battery_cap(need_w: float, current_w: float | None, slack_w: int, limit_w: int) -> tuple[int, bool]:
    """A cap on the battery's power (W, positive) for the plan's `need_w`, and whether the current one was kept.
    `current_w` (the register's cap now) is kept while it lies between the need and the need plus the slack;
    otherwise the cap is written at the need plus half the slack, rounded up to 100 W, so the plan can move either
    way before the next write (with a fixed step a plan around a step's edge would write every slot). Never above
    `limit_w`."""
    need = min(max(need_w, 0.0), float(limit_w))
    fresh = min(limit_w, math.ceil((need + slack_w / 2) / 100) * 100)
    if current_w is not None and need <= current_w <= min(max(need + slack_w, fresh), limit_w):
        current = round(current_w)
        return current, current != fresh
    return fresh, False


def _cap_text(need: float, cap: int, kept: bool, slack: int) -> str:
    if cap < need:
        return f"{cap} W (the configured limit; the plan: {need:.0f} W)"
    if kept:
        return f"{cap} W (kept: within {slack} W above the plan's {need:.0f} W)"
    if slack:
        return f"{cap} W (the plan's {need:.0f} W + {slack // 2} W, rounded up to 100 W)"
    return f"{cap} W (the plan's {need:.0f} W rounded up to 100 W)"


def decide(
    v: PlanValues, limits: InverterLimits, no_export_at_or_below: float | None, held: Observed | None = None
) -> Decision:
    """`no_export_at_or_below` (Settings → EMHASS → MPC) blocks export in cheap slots; None never blocks. `held` is
    what the registers show now: a battery cap there is kept while it is within the slack above the plan, and a
    feed-in limit while export is allowed and it lets out what can reach the grid (None: always the plan's)."""
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
    slack = limits.battery_cap_slack_w

    if g > BAND_W:  # importing
        if b < -BAND_W:
            grid = (
                limits.grid_import_max_w
                if limits.force_charge_at_import_max or g > limits.force_charge_grid_cap_above_w
                else _round100(g) + limits.force_charge_grid_margin_w
            )
            rule, why = "force_charge", f"importing and charging the battery; grid target {grid} W"
            if limits.force_charge_at_import_max:
                why += " (the import max: the battery limits its own charge)"
        elif b > BAND_W:
            rule, grid = "use_bat_import", 0
            if limits.cap_discharge_at_plan:
                now_w = -held.battery_min_w if held is not None and held.battery_min_w is not None else None
                cap, kept = battery_cap(b, now_w, slack, -limits.battery_min_w)
                bmin = -cap
                why = (
                    f"importing and discharging: the battery gives at most {_cap_text(b, cap, kept, slack)}, "
                    "the grid the rest"
                )
            else:
                why = "importing and discharging (use the battery, import the rest)"
        else:
            rule, why, grid = "use_only_grid", "importing, battery idle", 0
            bmin = 0
    elif g < -BAND_W:  # exporting
        if b < -BAND_W:
            rule, grid = "charge_export", 0
            if limits.cap_charge_at_plan and not cheap:
                now_w = held.battery_max_w if held is not None else None
                cap, kept = battery_cap(-b, now_w, slack, limits.battery_max_w)
                bmax = cap
                why = (
                    f"exporting while charging: the battery takes at most {_cap_text(-b, cap, kept, slack)}, "
                    "the rest is exported"
                )
            elif limits.cap_charge_at_plan:
                why = (
                    f"exporting while charging the battery; not capped: the price {price:.4f} €/kWh is at or below "
                    f"{threshold}, so the feed-in limit is 0 W and the battery keeps the PV"
                )
            else:
                why = "exporting while charging the battery"
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
            bmax = 0
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
    floor = ceiling = None
    if needed and not cheap and c <= 0:  # export allowed: any limit that lets out what can reach the grid will do
        ceiling = limits.export_max_w
        floor = min(ceiling, math.ceil(max(-g, -(b + g), 0.0) / 100) * 100)
    current = held.feedin_max_w if held is not None else None
    if floor is not None and ceiling is not None and current is not None and floor - 0.5 <= current <= ceiling + 0.5:
        feedin = round(current)
        feedin_why += f"; kept: {feedin} W is at least the {floor} W that can reach the grid ({need_why})"
    else:
        feedin_why += f"; written: {need_why}" if needed else f"; left as it is: {need_why}"
    label = LABELS[rule]
    branch = "self_use_keep_pv" if rule == "self_use" and g < -BAND_W else rule
    targets = Targets(label, grid, bmax, bmin)
    return Decision(
        rule,
        label,
        f"{why} ({vals})",
        targets,
        feedin,
        feedin_why,
        notes,
        needed,
        branch,
        feedin_floor_w=floor,
        feedin_ceiling_w=ceiling,
        p_batt_w=b,
    )


def compare_targets(
    targets: Targets | None,
    feedin_w: int | None,
    observed: Observed,
    feedin_range: tuple[int, int] | None = None,
) -> dict[str, Any]:
    """Field-by-field agreement between targets (None: not judged) and what the entities show. `feedin_range`: the
    feed-in limits that count as the same (default: exactly `feedin_w`)."""
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
        low, high = feedin_range or (feedin_w, feedin_w)
        got_feedin = observed.feedin_max_w
        same_feedin = got_feedin is not None and low - 0.5 < got_feedin < high + 0.5
        rows.append(
            {"field": "feedin_max_w", "decided": feedin_w, "observed": observed.feedin_max_w, "same": same_feedin}
        )
    return {"agree": all(r["same"] for r in rows), "fields": rows}


def compare(decision: Decision, observed: Observed) -> dict[str, Any]:
    """Field-by-field agreement between a decision and what the entities show (the feed-in only where it's written,
    and any limit in its range)."""
    return compare_targets(decision.targets, decision.feedin_target, observed, decision.feedin_range)
