"""What the Plan page's "this slot" shows: the plan row in force, the next one, what is measured now, and what
the inverter (and the EV charger) are set to. Reads only the watched Home Assistant states and stored plans."""

from datetime import timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.plan_now import Reading, compare, row_for
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
    return {"current_limit_a": observed.current_limit_a, "state_raw": observed.state_raw}


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


async def plan_now(c: Container) -> dict[str, Any]:
    now = c.clock.now()
    slot = slot_floor(now)
    plans = await c.extras["emhass"].plans(4)
    found = row_for(plans, slot)
    following = row_for(plans, slot + SLOT)
    published = c.extras["publish"].last_published_at
    out: dict[str, Any] = {
        "slot_start": iso(slot),
        "slot_end": iso(slot + SLOT),
        "published_at": iso(published) if published is not None and slot_floor(published) == slot else None,
        "row": None,
        "plan_generated_at": None,
        "plan_run_id": None,
        "next_start": iso(slot + SLOT),
        "next_row": following[1] if following else None,
        "quantities": [],
        "inverter": inverter_now(c),
        "charger": charger_now(c),
    }
    if found is None:
        return out
    plan, row, index = found
    rows = plan.get("plan") or []
    prev_row = rows[index - 1] if index > 0 else None
    fraction = (now - slot).total_seconds() / SLOT.total_seconds()
    out.update(
        row=row,
        plan_generated_at=plan.get("generated_at"),
        plan_run_id=plan.get("run_id"),
        quantities=compare(row, prev_row, measured_now(c), fraction, deferrable_now(c)),
    )
    return out
