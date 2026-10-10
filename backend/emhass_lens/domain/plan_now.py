"""The Plan page's "this slot": the plan row in force for the current quarter, the one after it, and how far what is
measured now is from it. Pure functions: plans, readings and `now` come in.

The plan in force for a slot is the newest stored plan that has a row for it: a run anchors at the next slot, so the
plan made during this quarter starts at the next one, and the plan that was published at this slot's start is the
newest one holding this slot.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from emhass_lens.core.clock import parse_iso
from emhass_lens.core.slots import slot_floor

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


def compare(
    row: dict[str, Any],
    prev_row: dict[str, Any] | None,
    measured: dict[str, Reading],
    fraction: float,
    deferrable_now: float | None = None,
) -> list[dict[str, Any]]:
    """Plan against measured, per quantity: {key, plan, expected, measured, entity, age_s, differs, sign_hint}.

    Only what the inverter controls is judged: the grid against the plan, the battery against what the plan means
    for the load and PV now, the SoC against where the plan expects it. House load and PV are forecasts: shown, never
    judged (`differs` None). EMHASS's signs (battery + discharge, grid + import)."""
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
            entry["differs"] = power_differs(plan, reading.value)
        elif key == "batt":
            expected = battery_expected(row, measured, deferrable_now)
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
