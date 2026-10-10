"""The inputs of one MPC run, frozen at the moment the run starts, each with where it came from."""

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from emhass_lens.domain.issues import Issue
from emhass_lens.domain.pv_solcast import PvForecast
from emhass_lens.domain.tariffs.engine import SlotPrice

UNAVAILABLE = {"unavailable", "unknown", "none", ""}


@dataclass(frozen=True, slots=True)
class Reading:
    """One value read from Home Assistant (or a fallback), with its story."""

    name: str
    value: float | bool | None
    source: str  # entity id, or "default"
    raw: Any = None
    age_s: float | None = None
    transform: str | None = None
    issue: str | None = None  # why the entity value couldn't be used

    def explain(self) -> str:
        parts = [f"{self.value!r} from {self.source}"]
        if self.raw is not None and self.source != "default":
            parts.append(f"state {self.raw!r}")
        if self.transform:
            parts.append(self.transform)
        if self.age_s is not None:
            parts.append(f"{int(self.age_s)} s old")
        if self.issue:
            parts.append(self.issue)
        return ", ".join(parts)


@dataclass(frozen=True)
class DeferrableReading:
    name: str
    enabled: Reading
    nominal_power_w: int
    operating_hours: Reading
    deadline_timesteps: Reading
    single_constant: Reading
    running: Reading | None = None  # None when no "running now" entity is configured


@dataclass(frozen=True)
class MpcInputs:
    taken_at: datetime
    prices: tuple[SlotPrice, ...]
    pv: PvForecast | None
    soc_init: Reading
    soc_final: Reading
    deferrables: tuple[DeferrableReading, ...]
    forecast_source: str
    extend_days: int
    issues: tuple[Issue, ...] = field(default_factory=tuple)


def read_number(
    name: str,
    entity_id: str,
    state: dict[str, Any] | None,
    now: datetime,
    scale: float = 1.0,
    default: float | None = None,
) -> Reading:
    """A numeric reading; falls back to `default` (if given) when the entity can't be used."""
    transform = f"× {scale:g}" if scale != 1.0 else None
    if state is None:
        return _fallback(name, entity_id, None, None, "entity not found", default)
    raw = state.get("state")
    age = _age(state, now)
    if str(raw).strip().lower() in UNAVAILABLE:
        return _fallback(name, entity_id, raw, age, f"entity is {raw!r}", default)
    try:
        number = float(raw)  # type: ignore[arg-type]
    except TypeError, ValueError:
        return _fallback(name, entity_id, raw, age, "state is not a number", default)
    if math.isnan(number) or math.isinf(number):
        return _fallback(name, entity_id, raw, age, "state is not a finite number", default)
    return Reading(name, number * scale, entity_id, raw=raw, age_s=age, transform=transform)


def read_bool(name: str, entity_id: str, state: dict[str, Any] | None, now: datetime) -> Reading:
    if not entity_id:
        return Reading(name, False, "default", issue="no entity configured")
    if state is None:
        return Reading(name, False, entity_id, issue="entity not found, treated as off")
    raw = state.get("state")
    return Reading(name, raw == "on", entity_id, raw=raw, age_s=_age(state, now))


def read_match(name: str, entity_id: str, state: dict[str, Any] | None, now: datetime, values: list[str]) -> Reading:
    """True when the entity's state is one of `values` (case-insensitive); a missing entity is no match."""
    if state is None:
        return Reading(name, False, entity_id, issue="entity not found, treated as not running")
    raw = state.get("state")
    wanted = {v.strip().lower() for v in values}
    return Reading(name, str(raw).strip().lower() in wanted, entity_id, raw=raw, age_s=_age(state, now))


def _fallback(name: str, entity_id: str, raw: Any, age: float | None, why: str, default: float | None) -> Reading:
    if default is not None:
        return Reading(name, default, "default", raw=raw, age_s=age, issue=f"{entity_id}: {why}, used the default")
    return Reading(name, None, entity_id, raw=raw, age_s=age, issue=why)


def _age(state: dict[str, Any], now: datetime) -> float | None:
    changed = state.get("last_updated") or state.get("last_changed")
    if not changed:
        return None
    try:
        when = datetime.fromisoformat(str(changed).replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0.0, (now - when).total_seconds())
