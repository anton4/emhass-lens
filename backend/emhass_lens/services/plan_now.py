"""What the Plan page's "this slot" shows: the plan row in force, the next one, what is measured now, and what
the inverter (and the EV charger) are set to; and the slot that just ended against its measured quarter-hour means.
Reads only the watched Home Assistant states, stored plans and stored measurements."""

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.inverter import Targets
from emhass_lens.domain.plan_now import Reading, compare, row_for, row_targets
from emhass_lens.services.ha_values import last_updated, num
from emhass_lens.services.measurements import FIELDS, QUANTITIES

if TYPE_CHECKING:
    from emhass_lens.container import Container

SLOT = timedelta(minutes=15)


def measured_now(c: Container) -> dict[str, Reading]:
    """The Measurements sensors as they read now, in EMHASS's units and signs (Multiply by, Invert applied)."""
    now = c.clock.now()
    m = c.settings.current.measurements
    ha = c.extras["ha"]
    out: dict[str, Reading] = {}
    for quantity in QUANTITIES:
        cfg = getattr(m, FIELDS[quantity])
        if not cfg.entity:
            out[quantity] = Reading(None, None, None)
            continue
        state = ha.state(cfg.entity)
        value = num(state)
        stamp = last_updated(state)
        out[quantity] = Reading(
            value * cfg.scale * (-1.0 if cfg.invert else 1.0) if value is not None else None,
            cfg.entity,
            (now - stamp).total_seconds() if stamp is not None else None,
        )
    return out


def inverter_now(c: Container) -> dict[str, Any] | None:
    inverter = c.extras.get("inverter")
    if inverter is None or inverter.mode == "off":
        return None
    writer = c.extras["sofar"]
    regs = writer.registers()
    reason = inverter.preconditions()
    slot = iso(slot_floor(c.clock.now()))
    applied = inverter.last_apply if inverter.last_apply and inverter.last_apply.get("slot") == slot else None
    return {
        "mode": inverter.mode,
        "in_control": reason is None,
        "reason": reason,
        "charger_mode": regs.charger_mode,
        "state": regs.state,
        "grid_power_w": regs.grid_power_w,
        "battery_max_w": regs.battery_max_w,
        "battery_min_w": regs.battery_min_w,
        "feedin_max_w": regs.feedin_max_w,
        "written_at": iso(max(writer.last_commit.values(), default=None)),
        "run_id": (applied or {}).get("run_id"),
    }


def charger_now(c: Container) -> dict[str, Any] | None:
    charger = c.extras.get("charger")
    if charger is None or charger.mode == "off":
        return None
    observed = charger.observed()
    e = c.settings.current.charger.entities
    ha = c.extras["ha"]
    # power_w follows the charging state, and the current limit while the car charges: the newest of them dates it
    sources = [e.charging_state_sensor] + ([e.current_limit_number] if observed.state_raw == 4 else [])
    stamps = [(stamp, entity) for entity in sources if entity and (stamp := last_updated(ha.state(entity)))]
    newest = max(stamps, default=None)
    return {
        "current_limit_a": observed.current_limit_a,
        "state_raw": observed.state_raw,
        "power_w": deferrable_now(c),
        "soc": num(ha.state(e.car_soc_sensor)) if e.car_soc_sensor else None,
        "target_soc": observed.target_soc,
        "entity": newest[1] if newest else None,
        "age_s": (c.clock.now() - newest[0]).total_seconds() if newest else None,
    }


def _emhass_config_number(c: Container, name: str) -> float | None:
    value = (c.extras["emhass"].config or {}).get(name)
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def soc_limits(c: Container) -> dict[str, float | None]:
    """EMHASS's battery state-of-charge limits (0–1) from its config: the plan stays between them."""
    return {
        "soc_min": _emhass_config_number(c, "battery_minimum_state_of_charge"),
        "soc_max": _emhass_config_number(c, "battery_maximum_state_of_charge"),
    }


def battery_power_limits(c: Container) -> tuple[float | None, float | None]:
    """EMHASS's battery charge and discharge power maxima (W) from its config."""
    return (
        _emhass_config_number(c, "battery_charge_power_max"),
        _emhass_config_number(c, "battery_discharge_power_max"),
    )


def slot_targets(c: Container, row: dict[str, Any], inverter: dict[str, Any] | None) -> Targets | None:
    """The inverter's passive settings for judging battery and grid in a slot: what its registers show now
    (`inverter`, from inverter_now) when they are all known, else what the inverter rules give the plan row. None
    while inverter control is off: then nothing says how the inverter splits the load."""
    control = c.extras.get("inverter")
    if control is None or control.mode == "off":
        return None
    regs = inverter or {}
    grid, bmax, bmin = (regs.get(k) for k in ("grid_power_w", "battery_max_w", "battery_min_w"))
    if isinstance(grid, int | float) and isinstance(bmax, int | float) and isinstance(bmin, int | float):
        return Targets(str(regs.get("state") or ""), round(grid), round(bmax), round(bmin))
    settings = c.settings.current
    return row_targets(row, settings.inverter.limits, settings.emhass.mpc.no_export_at_or_below)


def deferrable_now(c: Container) -> float | None:
    """The EV charger's power now (its current limit while charging), or None when the controller is off."""
    charger = c.extras.get("charger")
    if charger is None or charger.mode == "off":
        return None
    observed = charger.observed()
    if observed.state_raw is None or observed.state_raw < 0:
        return None
    if observed.state_raw != 4:
        return 0.0
    return (observed.current_limit_a or 0.0) * charger.limits.w_per_amp


def _row_before(plan: dict[str, Any], index: int) -> dict[str, Any] | None:
    rows = plan.get("plan") or []
    return rows[index - 1] if index > 0 else None


async def ended_slot(
    c: Container, found: tuple[dict[str, Any], dict[str, Any], int] | None, start: datetime
) -> list[dict[str, Any]]:
    """The plan for a slot that has ended against the quarter-hour means measured over it (stored by measure.sample
    soon after the slot ends). A mean SOC sits half-way between the planned start and end of the slot."""
    if found is None:
        return []
    plan, row, index = found
    means = await c.app_db.run(c.extras["measurements"].read, start, start + SLOT)
    m = c.settings.current.measurements
    readings: dict[str, Reading] = {}
    for quantity in QUANTITIES:
        hit = means.get(quantity, {}).get(iso(start) or "")
        readings[quantity] = Reading(hit[0] if hit else None, getattr(m, FIELDS[quantity]).entity or None, None)
    targets = slot_targets(c, row, None)  # the registers then aren't kept: what the rules gave the row
    return compare(row, _row_before(plan, index), readings, 0.5, None, targets, battery_power_limits(c))


async def plan_now(c: Container) -> dict[str, Any]:
    now = c.clock.now()
    slot = slot_floor(now)
    # a run anchors at the next slot, so the plan in force for the previous slot is usually the third newest
    plans = await c.extras["emhass"].plans(6)
    found = row_for(plans, slot)
    following = row_for(plans, slot + SLOT)
    earlier = row_for(plans, slot - SLOT)
    published = c.extras["publish"].last_published_at
    inverter = inverter_now(c)
    out: dict[str, Any] = {
        "slot_start": iso(slot),
        "slot_end": iso(slot + SLOT),
        "published_at": iso(published) if published is not None and slot_floor(published) == slot else None,
        "row": None,
        "plan_generated_at": None,
        "plan_run_id": None,
        "next_start": iso(slot + SLOT),
        "next_row": following[1] if following else None,
        "prev_start": iso(slot - SLOT),
        "prev_row": earlier[1] if earlier else None,
        "prev_quantities": await ended_slot(c, earlier, slot - SLOT),
        "quantities": [],
        "inverter": inverter,
        "charger": charger_now(c),
        **soc_limits(c),
    }
    if found is None:
        return out
    plan, row, index = found
    fraction = (now - slot).total_seconds() / SLOT.total_seconds()
    out.update(
        row=row,
        plan_generated_at=plan.get("generated_at"),
        plan_run_id=plan.get("run_id"),
        quantities=compare(
            row,
            _row_before(plan, index),
            measured_now(c),
            fraction,
            deferrable_now(c),
            slot_targets(c, row, inverter),
            battery_power_limits(c),
        ),
    )
    return out
