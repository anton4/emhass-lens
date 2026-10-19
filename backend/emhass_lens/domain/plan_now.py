"""The Plan page's "this slot": the plan row in force for the current quarter, the one after it, and how far what is
measured now is from it. Pure functions: plans, readings and `now` come in.

The plan in force for a slot is the newest stored plan that has a row for it: a run anchors at the next slot, so the
plan made during this quarter starts at the next one, and the plan that was published at this slot's start is the
newest one holding this slot.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.inverter import Decision, PlanValues, Targets, decide
from emhass_lens.settings.model import InverterLimits

POWER_W = 300.0  # a power differs when it is this far off ...
POWER_SHARE = 0.15  # ... and this share of the larger of the two
SOC_POINTS = 0.02  # the state of charge, 0–1

COLUMNS = {"batt": "P_batt", "grid": "P_grid", "pv": "P_PV", "load": "P_Load"}


@dataclass(frozen=True)
class Reading:
    value: float | None
    entity: str | None
    age_s: float | None


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except TypeError, ValueError:
        return None


def row_for(plans: list[dict[str, Any]], slot: datetime) -> tuple[dict[str, Any], dict[str, Any], int] | None:
    """(plan, row, row index) of the newest plan that has a row for `slot`; plans newest first."""
    for plan in plans:
        for index, row in enumerate(plan.get("plan") or []):
            stamp = parse_iso(str(row.get("timestamp"))) if row.get("timestamp") else None
            if stamp is not None and slot_floor(stamp) == slot:
                return plan, row, index
    return None


def soc_of(row: dict[str, Any] | None) -> float | None:
    if not row:
        return None
    value = _num(row.get("SOC_opt"))
    return value if value is not None else _num(row.get("SOC_opt_0"))


def power_differs(plan: float | None, measured: float | None) -> bool | None:
    if plan is None or measured is None:
        return None
    gap = abs(plan - measured)
    return gap > POWER_W and gap > POWER_SHARE * max(abs(plan), abs(measured))


def soc_expected(start: float | None, end: float | None, fraction: float) -> float | None:
    """Where the plan expects the state of charge part-way through the slot (`end` alone: the slot's end)."""
    if end is None:
        return None
    if start is None:
        return end
    return start + (end - start) * min(1.0, max(0.0, fraction))


def deferrable_of(row: dict[str, Any]) -> float | None:
    """The plan's deferrable loads together (P_deferrable0, P_deferrable1, ...)."""
    values = [_num(v) for k, v in row.items() if k.startswith("P_deferrable")]
    known = [v for v in values if v is not None]
    return sum(known) if known else None


def _now_or_plan(measured: dict[str, Reading], key: str, row: dict[str, Any]) -> float | None:
    reading = measured.get(key)
    if reading is not None and reading.value is not None:
        return reading.value
    return _num(row.get(COLUMNS[key]))


def battery_expected(row: dict[str, Any], measured: dict[str, Reading], deferrable_now: float | None) -> float | None:
    """What the plan means for the battery with the house load, PV and deferrable loads as they are now. With a grid
    target the inverter holds the grid and the battery covers the rest (P_PV + P_batt + P_grid = P_Load + P_def), so
    the battery follows every difference between the forecasts and reality."""
    planned = _num(row.get(COLUMNS["batt"]))
    if planned is None:
        return None
    expected = planned
    load_now = (measured.get("load") or Reading(None, None, None)).value
    pv_now = (measured.get("pv") or Reading(None, None, None)).value
    load_plan, pv_plan, def_plan = _num(row.get(COLUMNS["load"])), _num(row.get(COLUMNS["pv"])), deferrable_of(row)
    if load_now is not None and load_plan is not None:
        expected += load_now - load_plan
    if pv_now is not None and pv_plan is not None:
        expected -= pv_now - pv_plan
    if deferrable_now is not None and def_plan is not None:
        expected += deferrable_now - def_plan
    return expected


def net_demand(row: dict[str, Any], measured: dict[str, Reading], deferrable_now: float | None) -> float | None:
    """What the house and the deferrable loads need beyond the PV now (W; negative: PV to spare), from what is
    measured, else the plan's forecasts. The battery and the grid together cover it: P_batt + P_grid."""
    load, pv = _now_or_plan(measured, "load", row), _now_or_plan(measured, "pv", row)
    if load is None or pv is None:
        return None
    deferrable = deferrable_now if deferrable_now is not None else deferrable_of(row)
    return load + (deferrable or 0.0) - pv


def inverter_expected(
    demand: float, targets: Targets, batt_limits: tuple[float | None, float | None] = (None, None)
) -> tuple[float, float]:
    """(battery, grid) where a Sofar in passive mode settles for `demand` (net_demand): it holds the grid at its target
    and the battery covers the rest, within the battery window; what the battery can't take goes to the grid. The
    window is −battery_max … −battery_min in EMHASS's signs (Sofar counts charging as positive), narrowed by EMHASS's
    `batt_limits` (charge max, discharge max), so a force charge at the import max is held to what the battery takes."""
    lo, hi = float(-targets.battery_max_w), float(-targets.battery_min_w)
    charge_max, discharge_max = batt_limits
    if charge_max is not None:
        lo = max(lo, -charge_max)
    if discharge_max is not None:
        hi = min(hi, discharge_max)
    battery = min(hi, max(lo, demand - targets.grid_power_w))
    return battery, demand - battery


def row_decision(row: dict[str, Any], limits: InverterLimits, no_export_at_or_below: float | None) -> Decision | None:
    """What the inverter rules decide for a plan row (what the automation and EMHASS Lens set for it), without the
    registers that will be held then: its state is what will be set, its caps can still differ. None without P_batt
    or P_grid."""
    batt, grid = _num(row.get(COLUMNS["batt"])), _num(row.get(COLUMNS["grid"]))
    if batt is None or grid is None:
        return None
    values = PlanValues(
        p_batt=batt,
        p_grid=grid,
        p_pv=_num(row.get(COLUMNS["pv"])) or 0.0,
        p_pv_curtailment=_num(row.get("P_PV_curtailment")) or 0.0,
        export_price=_num(row.get("unit_prod_price")),
        soc=soc_of(row),
    )
    return decide(values, limits, no_export_at_or_below)


def row_targets(row: dict[str, Any], limits: InverterLimits, no_export_at_or_below: float | None) -> Targets | None:
    """The passive settings the inverter rules give a plan row (what the automation and EMHASS Lens set for it)."""
    decision = row_decision(row, limits, no_export_at_or_below)
    return decision.targets if decision is not None else None


def planned_slots(
    rows: list[dict[str, Any]], after: datetime, limits: InverterLimits, no_export_at_or_below: float | None
) -> list[dict[str, Any]]:
    """The inverter's planned mode for each plan row whose slot starts after `after` (the slot in force), in order:
    the slot, the passive state and rule, the settings, the feed-in limit (None: left as it is) and the plan's battery
    power. Rows without a timestamp or without P_batt and P_grid are left out."""
    out: list[dict[str, Any]] = []
    for row in rows:
        stamp = parse_iso(str(row.get("timestamp"))) if row.get("timestamp") else None
        if stamp is None or slot_floor(stamp) <= after:
            continue
        decision = row_decision(row, limits, no_export_at_or_below)
        if decision is None or decision.targets is None:
            continue
        t = decision.targets
        out.append(
            {
                "slot": iso(slot_floor(stamp)),
                "state": t.state,
                "rule": decision.rule,
                "grid_power_w": t.grid_power_w,
                "battery_min_w": t.battery_min_w,
                "battery_max_w": t.battery_max_w,
                "feedin_max_w": decision.feedin_target,
                "p_batt_w": decision.p_batt_w,
            }
        )
    return sorted(out, key=lambda s: s["slot"])


def compare(
    row: dict[str, Any],
    prev_row: dict[str, Any] | None,
    measured: dict[str, Reading],
    fraction: float,
    deferrable_now: float | None = None,
    targets: Targets | None = None,
    batt_limits: tuple[float | None, float | None] = (None, None),
) -> list[dict[str, Any]]:
    """Plan against measured, per quantity: {key, plan, expected, measured, entity, age_s, differs, sign_hint}.

    Only what the inverter controls is judged, against what the plan means with the house load, PV and deferrable
    loads as they are now. With the inverter's passive `targets` the battery and the grid are both judged against
    where the inverter settles (inverter_expected): in PV export the battery can't charge, so more PV than forecast
    goes to the grid. Without them the grid is judged against the plan and the battery takes every difference. The SoC
    is judged against where the plan expects it. House load and PV are forecasts: shown, never judged (`differs`
    None). EMHASS's signs (battery + discharge, grid + import)."""
    settled = None
    if targets is not None and (demand := net_demand(row, measured, deferrable_now)) is not None:
        settled = inverter_expected(demand, targets, batt_limits)
    out: list[dict[str, Any]] = []
    for key, column in COLUMNS.items():
        plan = _num(row.get(column))
        reading = measured.get(key) or Reading(None, None, None)
        entry: dict[str, Any] = {
            "key": key,
            "plan": plan,
            "expected": None,
            "measured": reading.value,
            "entity": reading.entity,
            "age_s": reading.age_s,
            "differs": None,
            "sign_hint": False,
        }
        if key == "grid":
            entry["expected"] = settled[1] if settled is not None else None
            entry["differs"] = power_differs(settled[1] if settled is not None else plan, reading.value)
        elif key == "batt":
            expected = settled[0] if settled is not None else battery_expected(row, measured, deferrable_now)
            entry["expected"] = expected
            entry["differs"] = power_differs(expected, reading.value)
            entry["sign_hint"] = bool(
                expected is not None
                and reading.value is not None
                and abs(expected) >= POWER_W
                and abs(reading.value) >= POWER_W
                and (expected > 0) != (reading.value > 0)
            )
        out.append(entry)
    end = soc_of(row)
    reading = measured.get("soc") or Reading(None, None, None)
    expected = soc_expected(soc_of(prev_row), end, fraction)
    differs = None if expected is None or reading.value is None else abs(reading.value - expected) > SOC_POINTS
    out.append(
        {
            "key": "soc",
            "plan": end,
            "expected": expected,
            "measured": reading.value,
            "entity": reading.entity,
            "age_s": reading.age_s,
            "differs": differs,
            "sign_hint": False,
        }
    )
    return out
