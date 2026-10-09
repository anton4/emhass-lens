"""Solcast PV forecast (BJReplay ha-solcast-solar) reshaped to 15-minute watts.

Each day sensor (…_today, …_tomorrow, …_day_3 … …_day_7) has a `detailedForecast` attribute with
30-minute periods: {"period_start": "...+03:00", "pv_estimate": kW, "pv_estimate10": kW, ...}.
Periods are keyed by their timestamp, so a missing day sensor or a 23/25-hour DST day can't
shift the rest of the series; slots without data are reported, not silently zero-filled.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

QUARTER = timedelta(minutes=15)
DAY_SUFFIXES = ("today", "tomorrow", "day_3", "day_4", "day_5", "day_6", "day_7")


@dataclass(frozen=True)
class PvForecast:
    watts: dict[datetime, float]  # UTC slot start -> W
    field_name: str
    sensors_used: tuple[str, ...]
    sensors_missing: tuple[str, ...]
    meta: dict[str, Any] = field(default_factory=dict)

    def series(self, starts: list[datetime]) -> tuple[list[float], list[datetime]]:
        """Values for the given slot starts (0 W where missing) and the starts that were missing."""
        values, missing = [], []
        for start in starts:
            value = self.watts.get(start)
            if value is None:
                missing.append(start)
                value = 0.0
            values.append(value)
        return values, missing


def day_sensors(prefix: str, days: int) -> list[str]:
    return [f"{prefix}{suffix}" for suffix in DAY_SUFFIXES[:days]]


def parse(states: dict[str, dict[str, Any] | None], field_name: str, scale: float = 1.0) -> PvForecast:
    """states: entity_id -> HA state dict ({"state":..., "attributes": {...}}) or None if missing."""
    key = f"pv_{field_name}"
    watts: dict[datetime, float] = {}
    used, missing = [], []
    for entity_id, state in states.items():
        attrs = (state or {}).get("attributes") or {}
        periods = attrs.get("detailedForecast")
        if not periods:
            missing.append(entity_id)
            continue
        used.append(entity_id)
        for period in periods:
            start_raw = period.get("period_start")
            value = period.get(key)
            if start_raw is None or value is None:
                continue
            start = _ts(start_raw)
            length = timedelta(minutes=30)
            w = float(value) * 1000.0 * scale
            slot = start
            while slot < start + length:
                watts[slot] = w
                slot += QUARTER
    return PvForecast(watts=watts, field_name=field_name, sensors_used=tuple(used), sensors_missing=tuple(missing))


def _ts(value: Any) -> datetime:
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)
