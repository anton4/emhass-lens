"""No export at or below a price: a per-slot maximum_power_to_grid that EMHASS plans with.

EMHASS 0.16+ takes maximum_power_to_grid as a list with one value per slot. 0 W in a slot is a hard limit that every
cost function respects. The PV it can't use or store then has to be curtailed, so the limit is only sent when
EMHASS models curtailment (compute_curtailment); otherwise a full battery in sunshine would make the plan infeasible.
"""

from typing import Any

GRID_LIMIT_VERSION = (0, 16, 0)
EMHASS_DEFAULT_TO_GRID_W = 9000.0


def blocker(config: dict[str, Any] | None, version: tuple[int, ...] | None) -> str | None:
    """Why the per-slot export limit can't be sent to this EMHASS, or None when it can."""
    if version is None:
        return "EMHASS's version is unknown (it takes a per-slot export limit from 0.16)"
    if version < GRID_LIMIT_VERSION:
        return f"EMHASS {'.'.join(map(str, version))} takes a per-slot export limit only from 0.16"
    if not config:
        return "EMHASS's configuration couldn't be read"
    if config.get("compute_curtailment") not in (True, "true", "True"):
        return "compute_curtailment is off in EMHASS, so it couldn't curtail the PV it may not export"
    return None


def configured_max_w(config: dict[str, Any] | None) -> float:
    """EMHASS's own maximum_power_to_grid (its first value when it is a list), the export maximum of open slots."""
    value: Any = (config or {}).get("maximum_power_to_grid")
    if isinstance(value, list):
        value = value[0] if value else None
    try:
        number = float(value)
    except TypeError, ValueError:
        return EMHASS_DEFAULT_TO_GRID_W
    return number if number >= 0 else EMHASS_DEFAULT_TO_GRID_W


def slot_limits(prices: list[float], threshold: float, open_max_w: float) -> list[float]:
    """0 W in every slot whose export price is at or below `threshold`, `open_max_w` elsewhere."""
    return [0.0 if price <= threshold else open_max_w for price in prices]
