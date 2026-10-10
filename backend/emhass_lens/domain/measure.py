"""Quarter-hour means of Home Assistant history. Pure functions, no I/O.

The recorder gives state changes; each state holds until the next one. A slot's value is the
time-weighted mean of the numeric states covering it, and `coverage` says how much of the slot
had a numeric state at all (unavailable/unknown and gaps count as nothing).
"""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from emhass_lens.core.clock import parse_iso


@dataclass(frozen=True)
class SlotMean:
    start: datetime
    value: float | None  # None when less than `min_coverage` of the slot had a numeric state
    coverage: float  # 0–1


def numeric(state: Any) -> float | None:
    """A finite float from a Home Assistant state, else None (unavailable, unknown, text, NaN)."""
    if isinstance(state, bool):
        return None
    try:
        value = float(state)
    except TypeError, ValueError:
        return None
    return value if math.isfinite(value) else None


def _segments(states: list[dict[str, Any]]) -> list[tuple[float, float | None]]:
    """(timestamp, numeric value or None) sorted by time; a state holds until the next entry."""
    out: list[tuple[float, float | None]] = []
    for s in states:
        stamp = parse_iso(s.get("last_changed") or s.get("last_updated"))
        if stamp is None:
            continue
        out.append((stamp.timestamp(), numeric(s.get("state"))))
    out.sort(key=lambda p: p[0])
    return out


def slot_means(
    states: list[dict[str, Any]],
    start: datetime,
    end: datetime,
    step_s: int = 900,
    min_coverage: float = 0.5,
) -> list[SlotMean]:
    """Time-weighted means per `step_s` slot of [start, end) from recorder history items
    ({"state": ..., "last_changed": ...}); the first item may be older than `start` (the state in force then)."""
    segments = _segments(states)
    out: list[SlotMean] = []
    slot = start
    i = 0
    while slot < end:
        slot_a = slot.timestamp()
        slot_b = slot_a + step_s
        # move to the last segment that starts at or before the slot start
        while i + 1 < len(segments) and segments[i + 1][0] <= slot_a:
            i += 1
        weighted = 0.0
        covered = 0.0
        j = i
        while j < len(segments) and segments[j][0] < slot_b:
            seg_a = max(segments[j][0], slot_a)
            seg_b = min(segments[j + 1][0] if j + 1 < len(segments) else slot_b, slot_b)
            value = segments[j][1]
            if seg_b > seg_a and value is not None:
                weighted += value * (seg_b - seg_a)
                covered += seg_b - seg_a
            j += 1
        coverage = covered / step_s
        mean = weighted / covered if covered > 0 and coverage >= min_coverage else None
        out.append(SlotMean(slot, mean, round(coverage, 4)))
        slot += timedelta(seconds=step_s)
    return out
