"""Whether a controlled device drifted from what EMHASS Lens set, and whether to set it back. Pure functions.

Checked every minute. A difference is only corrected when it is seen twice in a row with the same values, at least
30 s apart (one odd reading isn't drift), not within a settle time after EMHASS Lens's own write (Home Assistant's
polling shows the old value for a while), and not more than `fight_limit` times per field within an hour: when
something else keeps changing the device, correcting it again and again would only wear it (the Sofar's apply button
writes EEPROM), so the App stops for an hour and says so.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

Pair = tuple[Any, Any]  # (observed, expected)


@dataclass(frozen=True)
class DriftTracker:
    seen: dict[str, Pair] = field(default_factory=dict)  # the differences first seen at `seen_at`
    seen_at: datetime | None = None
    corrections: dict[str, tuple[datetime, ...]] = field(default_factory=dict)  # per field, within the window
    fighting: dict[str, Any] | None = None  # {field, since, count} while corrections are paused

    def corrections_since(self, since: datetime) -> int:
        return sum(1 for times in self.corrections.values() for t in times if t >= since)


def assess(
    tracker: DriftTracker,
    now: datetime,
    differing: dict[str, Pair],
    last_write_at: datetime | None,
    *,
    settle_s: float = 120,
    confirm_s: float = 30,
    fight_limit: int = 3,
    fight_window: timedelta = timedelta(hours=1),
    fight_pause: timedelta = timedelta(hours=1),
) -> tuple[DriftTracker, str]:
    """(new tracker, action): "ok", "settling", "watch", "correct" or "fighting"."""
    corrections = {f: tuple(t for t in times if now - t < fight_window) for f, times in tracker.corrections.items()}
    corrections = {f: times for f, times in corrections.items() if times}
    fighting = tracker.fighting
    if fighting is not None and now - fighting["since"] >= fight_pause:
        fighting = None
    if not differing:
        return DriftTracker({}, None, corrections, fighting), "ok"
    if last_write_at is not None and (now - last_write_at).total_seconds() < settle_s:
        return DriftTracker({}, None, corrections, fighting), "settling"
    if fighting is not None:
        return DriftTracker(dict(differing), now, corrections, fighting), "fighting"
    if any(tracker.seen.get(f) != pair for f, pair in differing.items()) or tracker.seen_at is None:
        return DriftTracker(dict(differing), now, corrections, fighting), "watch"
    if (now - tracker.seen_at).total_seconds() < confirm_s:
        return DriftTracker(tracker.seen, tracker.seen_at, corrections, fighting), "watch"  # seen again too soon
    for f in sorted(differing):
        if len(corrections.get(f, ())) >= fight_limit:
            fight = {"field": f, "since": now, "count": len(corrections[f])}
            return DriftTracker({}, None, corrections, fight), "fighting"
    corrections = {**corrections, **{f: (*corrections.get(f, ()), now) for f in differing}}
    return DriftTracker({}, None, corrections, None), "correct"


def _value(value: Any, unit: str) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"{value:g} {unit}".rstrip()
    return str(value)


def describe(differing: dict[str, Pair], labels: dict[str, tuple[str, str]]) -> str:
    """ "grid power 3000 W, expected 5600 W; feed-in limit 0 W, expected 15500 W". `labels`: field → (name, unit)."""
    parts = []
    for f, (observed, expected) in differing.items():
        name, unit = labels.get(f, (f.replace("_", " "), ""))
        parts.append(f"{name} {_value(observed, unit)}, expected {_value(expected, unit)}")
    return "; ".join(parts)
