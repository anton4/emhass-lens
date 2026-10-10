"""PV reserved for the EV while it charges from excess solar, as pure functions.

In Excess Solar mode the charger takes the PV surplus outside EMHASS's plan. EMHASS has no input for that, so the
App sends it a smaller PV forecast: for every slot, the charger's expected draw (the Excess Solar rule applied to
the PV forecast minus the house load EMHASS itself forecasts) is subtracted, until the energy the car still needs
is covered.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.charger import solar_amps
from emhass_lens.settings.model import ChargerLimits

SLOT_H = 0.25


@dataclass(frozen=True)
class EvReserve:
    """What is reserved per slot and why (or why nothing is)."""

    active: bool
    why: str
    watts: dict[datetime, float] = field(default_factory=dict)  # UTC slot start -> W taken by the charger
    energy_needed_wh: float | None = None
    energy_reserved_wh: float = 0.0
    until: datetime | None = None  # the last slot with a reservation
    soc: float | None = None
    target_soc: float | None = None

    def at(self, start: datetime) -> float:
        return self.watts.get(start, 0.0) if self.active else 0.0

    @property
    def max_w(self) -> float:
        return max(self.watts.values(), default=0.0)

    def summary(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "why": self.why,
            "energy_needed_wh": self.energy_needed_wh,
            "energy_reserved_wh": round(self.energy_reserved_wh),
            "until": iso(self.until) if self.until else None,
            "max_w": self.max_w,
            "slots": len(self.watts),
            "soc": self.soc,
            "target_soc": self.target_soc,
        }


def inactive(why: str, soc: float | None = None, target_soc: float | None = None) -> EvReserve:
    return EvReserve(False, why, soc=soc, target_soc=target_soc)


def blocker(
    charge_mode: str | None, solar_option: str, state_raw: int, soc: float, target_soc: float | None
) -> str | None:
    """Why the car is not charging from excess solar right now, or None when it is (or will when the sun comes)."""
    if charge_mode != solar_option:
        return f"the charge mode is {charge_mode or 'unknown'}, not {solar_option}"
    if state_raw < 0:
        return "the charger's state is unknown"
    if state_raw == 0:
        return "the car is unplugged"
    target = target_soc if target_soc is not None else 100.0
    if soc >= target:
        return f"the car is at {soc:.0f} %, target {target:.0f} %"
    return None


def load_by_slot(plan: list[dict[str, Any]]) -> dict[datetime, float]:
    """{UTC slot start: P_Load} from EMHASS's plan rows: the house load it forecasts without deferrable loads."""
    out: dict[datetime, float] = {}
    for row in plan:
        stamp = parse_iso(str(row.get("timestamp"))) if row.get("timestamp") else None
        if stamp is None:
            continue
        try:
            value = float(row.get("P_Load"))  # type: ignore[arg-type]
        except TypeError, ValueError:
            continue
        out[slot_floor(stamp)] = value
    return out


def house_load_profile(known: dict[datetime, float], starts: list[datetime]) -> dict[datetime, float]:
    """The house load for each wanted slot: the plan's value, else the value 24 h earlier in the plan, else the
    plan's mean. Empty when the plan has nothing."""
    if not known:
        return {}
    mean = sum(known.values()) / len(known)
    out: dict[datetime, float] = {}
    for start in starts:
        value = known.get(start)
        if value is None:
            value = known.get(start - timedelta(hours=24))
        if value is None:
            value = known.get(start - timedelta(hours=48))
        out[start] = mean if value is None else value
    return out


def plan_reserve(
    *,
    starts: list[datetime],
    pv_w: list[float],
    load_w: dict[datetime, float],
    soc: float,
    target_soc: float | None,
    solar_limit_a: int,
    limits: ChargerLimits,
    capacity_kwh: float,
    slot_h: float = SLOT_H,
) -> EvReserve:
    """Reserve the Excess Solar draw slot by slot until the car's remaining energy is covered."""
    target = target_soc if target_soc is not None else 100.0
    needed = max(0.0, target - soc) / 100.0 * capacity_kwh * 1000.0
    watts: dict[datetime, float] = {}
    reserved = 0.0
    for start, pv in zip(starts, pv_w, strict=True):
        if reserved >= needed:
            break
        load = load_w.get(start)
        if load is None:
            continue
        amps = solar_amps(pv - load, solar_limit_a, limits)
        if amps <= 0:
            continue
        draw = amps * limits.w_per_amp
        remaining_wh = needed - reserved
        if draw * slot_h > remaining_wh:
            draw = remaining_wh / slot_h  # the last slot only takes what is still missing
        watts[start] = round(draw)
        reserved += draw * slot_h
    why = f"Excess Solar, car {soc:.0f} % → {target:.0f} %, {needed / 1000:.1f} kWh to go"
    if not watts:
        why += "; no PV surplus in the forecast"
    return EvReserve(
        True,
        why,
        watts=watts,
        energy_needed_wh=round(needed),
        energy_reserved_wh=reserved,
        until=max(watts) if watts else None,
        soc=soc,
        target_soc=target,
    )
