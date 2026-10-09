"""Reading Home Assistant states the way the automations' Jinja filters do (`| float(0)`, `| int(-1)`, …)."""

from datetime import datetime
from typing import Any

from emhass_lens.core.clock import parse_iso


def num(state: dict[str, Any] | None) -> float | None:
    """The state as a number, or None when there is no state or it isn't numeric."""
    try:
        return float((state or {}).get("state"))  # type: ignore[arg-type]
    except TypeError, ValueError:
        return None


def number(state: dict[str, Any] | None, default: float) -> float:
    """Jinja `| float(default)`."""
    value = num(state)
    return default if value is None else value


def integer(state: dict[str, Any] | None, default: int) -> int:
    """Jinja `| int(default)`: whole numbers and numeric strings, "4.0" included; anything else is the default."""
    raw = (state or {}).get("state")
    try:
        return int(raw)  # type: ignore[arg-type]
    except TypeError, ValueError:
        pass
    try:
        return int(float(raw))  # type: ignore[arg-type]
    except TypeError, ValueError, OverflowError:
        return default


def text(state: dict[str, Any] | None) -> str | None:
    value = (state or {}).get("state")
    return None if value is None else str(value)


def updated(state: dict[str, Any] | None) -> datetime | None:
    """When HA last wrote the state (last_reported also moves when the value didn't change)."""
    if not state:
        return None
    stamps = [parse_iso(str(state.get(k))) for k in ("last_reported", "last_updated") if state.get(k)]
    stamps = [t for t in stamps if t is not None]
    return max(stamps) if stamps else None


def last_updated(state: dict[str, Any] | None) -> datetime | None:
    """HA's last_updated alone: when the state or its attributes last changed (what `states.x.last_updated` gives)."""
    if not state:
        return None
    return parse_iso(str(state.get("last_updated"))) if state.get("last_updated") else None
