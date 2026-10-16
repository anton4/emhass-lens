"""What one MPC payload gave EMHASS, slot by slot, for the Inputs page's charts.

The payload's lists are positional from the anchor; the explain slots carry their times. The house load is the one
input EMHASS forecasts itself (its ML model learns from `var_model`), so its series comes from the plan EMHASS made,
unless the payload sent one (`load_power_forecast` through extra runtime parameters).
"""

from datetime import datetime
from typing import Any

from emhass_lens.core.clock import parse_iso


def load_series(
    payload: dict[str, Any], starts: list[datetime], plan_rows: list[dict[str, Any]] | None
) -> tuple[str, list[float | None]]:
    """("sent", the payload's load_power_forecast) when the payload had one, else ("plan", P_Load of the plan rows on
    these slots), else ("none", all None)."""
    sent = payload.get("load_power_forecast")
    if isinstance(sent, list) and sent:
        values: list[float | None] = [_number(sent[i]) if i < len(sent) else None for i in range(len(starts))]
        return "sent", values
    if not plan_rows:
        return "none", [None] * len(starts)
    by_start: dict[datetime, float | None] = {}
    for row in plan_rows:
        stamp = parse_iso(str(row.get("timestamp")))
        if stamp is not None:
            by_start[stamp] = _number(row.get("P_Load"))
    values = [by_start.get(start) for start in starts]
    if all(v is None for v in values):
        return "none", values
    return "plan", values


START_KEYS = ("start_timesteps_of_each_deferrable_load", "def_start_timestep")


def _starts(source: dict[str, Any] | None) -> list[Any] | None:
    """The deferrable loads' first allowed timesteps a payload or EMHASS's config gives (either name), or None."""
    for key in START_KEYS:
        value = (source or {}).get(key)
        if isinstance(value, list):
            return value
    return None


def deferrables(
    payload: dict[str, Any], described: list[dict[str, Any]], emhass_config: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """One row per deferrable load: what the payload sent for it, beside what its Home Assistant entities say it
    would ask for when it is switched on (a load that is off is sent as 0 W for 0 h); and the first timestep it may
    run in, which EMHASS takes from the payload when it is there and else from its own config."""
    count = int(payload.get("number_of_deferrable_loads") or 0)
    sent_starts, config_starts = _starts(payload), _starts(emhass_config)
    nominal = payload.get("nominal_power_of_deferrable_loads") or []
    hours = payload.get("operating_hours_of_each_deferrable_load") or []
    ends = payload.get("end_timesteps_of_each_deferrable_load") or []
    single = payload.get("set_deferrable_load_single_constant") or []
    out: list[dict[str, Any]] = []
    for i in range(count):
        about = described[i] if i < len(described) else {}
        enabled = about.get("enabled") or {}
        power = _number(nominal[i]) if i < len(nominal) else None
        on = enabled.get("value") is True if enabled else bool(power)
        out.append(
            {
                "name": about.get("name") or f"Load {i + 1}",
                "on": on,
                "nominal_power_w": power or 0.0,
                "operating_hours": (_number(hours[i]) if i < len(hours) else None) or 0.0,
                "end_timesteps": int(_number(ends[i]) or 0) if i < len(ends) else 0,
                "single_constant": bool(single[i]) if i < len(single) else False,
                "configured_power_w": _number(about.get("nominal_power_w")),
                "configured_hours": _number((about.get("operating_hours") or {}).get("value")),
                "configured_end_timesteps": _whole((about.get("deadline_timesteps") or {}).get("value")),
                "enabled_source": enabled.get("source"),
                **_start(i, sent_starts, config_starts),
            }
        )
    return out


def _start(i: int, sent: list[Any] | None, config: list[Any] | None) -> dict[str, Any]:
    for values, source in ((sent, "payload"), (config, "emhass_config")):
        if values is not None and i < len(values):
            return {"start_timesteps": _whole(values[i]), "start_source": source}
    return {"start_timesteps": None, "start_source": None}


def soc_limits(payload: dict[str, Any], emhass_config: dict[str, Any] | None) -> tuple[float | None, float | None]:
    """The battery's state-of-charge limits (0–1) the plan stays between: the payload's (extra runtime parameters)
    when it has them, else EMHASS's config."""

    def pick(key: str) -> float | None:
        value = _number(payload.get(key))
        return value if value is not None else _number((emhass_config or {}).get(key))

    return pick("battery_minimum_state_of_charge"), pick("battery_maximum_state_of_charge")


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except TypeError, ValueError:
        return None


def _whole(value: Any) -> int | None:
    number = _number(value)
    return int(number) if number is not None else None
