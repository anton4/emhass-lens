"""Means of Home Assistant history. Pure functions, no I/O.

The recorder gives state changes; each state holds until the next one. A slot's value is the
time-weighted mean of the numeric states covering it, and `coverage` says how much of the slot
had a numeric state at all (unavailable/unknown and gaps count as nothing).

`detail` serves a finer line than the quarter-hour means: every change when they fit the point
budget, else means over a step that suits the window, broken at given moments (the market's
commands) so each of them gets a mean of its own. Each mean comes with the lowest and highest
value in its bucket, so a chart can still draw every spike when it shows a long window.
"""

import bisect
import itertools
import math
from collections.abc import Iterable
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
    slots: list[datetime] = []
    slot = start
    while slot < end:
        slots.append(slot)
        slot += timedelta(seconds=step_s)
    edges = [s.timestamp() for s in slots] + [slot.timestamp()]
    means = bucket_means(_segments(states), edges, min_coverage)
    return [SlotMean(s, mean, coverage) for s, (mean, coverage) in zip(slots, means, strict=True)]


# --- a finer line: every change, or means over a step that suits the window --------------------------------------

Point = tuple[float, float | None]  # (unix seconds, value or None); holds until the next point
Bounds = tuple[float | None, float | None]  # the lowest and highest value in a bucket; (None, None) for none

STEPS = (10, 30, 60, 120, 300, 600, 900)
BREAK_MERGE_S = 1.0  # moments closer than this are one


def bucket_means(
    points: list[Point], edges: list[float], min_coverage: float = 0.5
) -> list[tuple[float | None, float]]:
    """(mean, coverage 0–1) for each bucket [edges[i], edges[i+1]) of a step function given as sorted points; the
    last point holds to the end. The mean is None when less than `min_coverage` of the bucket had a value."""
    out: list[tuple[float | None, float]] = []
    i = 0
    n = len(points)
    for a, b in itertools.pairwise(edges):
        # move to the last point at or before the bucket start
        while i + 1 < n and points[i + 1][0] <= a:
            i += 1
        weighted = 0.0
        covered = 0.0
        j = i
        while j < n and points[j][0] < b:
            seg_a = max(points[j][0], a)
            seg_b = min(points[j + 1][0] if j + 1 < n else b, b)
            value = points[j][1]
            if seg_b > seg_a and value is not None:
                weighted += value * (seg_b - seg_a)
                covered += seg_b - seg_a
            j += 1
        coverage = covered / (b - a) if b > a else 0.0
        mean = weighted / covered if covered > 0 and coverage >= min_coverage else None
        out.append((mean, round(coverage, 4)))
    return out


def bucket_extremes(points: list[Point], edges: list[float]) -> list[Bounds]:
    """(lowest, highest) value the step function given as sorted points takes in each bucket [edges[i], edges[i+1]),
    however briefly; (None, None) where it has no value there. The last point holds to the end."""
    out: list[Bounds] = []
    i = 0
    n = len(points)
    for a, b in itertools.pairwise(edges):
        while i + 1 < n and points[i + 1][0] <= a:
            i += 1
        lo: float | None = None
        hi: float | None = None
        j = i
        while j < n and points[j][0] < b:
            seg_b = points[j + 1][0] if j + 1 < n else b
            value = points[j][1]
            if value is not None and seg_b > a:
                lo = value if lo is None else min(lo, value)
                hi = value if hi is None else max(hi, value)
            j += 1
        out.append((lo, hi))
    return out


def clip_points(points: list[Point], start: float, end: float) -> list[Point]:
    """The step function on [start, end): a first point at `start` with the value in force then (None when there was
    none), then the changes inside the window. `points` are sorted by time."""
    first = bisect.bisect_right(points, start, key=lambda p: p[0])
    last = bisect.bisect_left(points, end, key=lambda p: p[0])
    before = points[first - 1][1] if first > 0 else None
    return [(start, before), *points[first:last]]


def step_points(states: list[dict[str, Any]], start: float, end: float) -> list[Point]:
    """Recorder history items as a step function on [start, end) (see `clip_points`)."""
    return clip_points(_segments(states), start, end)


def pick_step(window_s: float, max_points: int) -> int:
    """The finest step from STEPS that keeps the window within `max_points` buckets (the coarsest when none does)."""
    for step in STEPS:
        if window_s / step <= max_points:
            return step
    return STEPS[-1]


def detail_edges(start: float, end: float, step_s: int, breaks: Iterable[float]) -> list[float]:
    """Bucket edges for [start, end): multiples of `step_s` (from the epoch) and every break inside the window. A
    multiple closer than a quarter step to a break gives way to it, so no sliver buckets; breaks within a second of
    each other (or of the window's ends) count once."""
    kept: list[float] = [start]
    for t in sorted(t for t in breaks if start < t < end):
        if t - kept[-1] >= BREAK_MERGE_S and end - t >= BREAK_MERGE_S:
            kept.append(t)
    marks = kept[1:]
    edges = [start, *marks, end]
    t = (math.floor(start / step_s) + 1) * step_s
    while t < end:
        k = bisect.bisect_left(marks, t)
        near = min(
            (abs(t - marks[i]) for i in (k - 1, k) if 0 <= i < len(marks)),
            default=math.inf,
        )
        if near >= step_s / 4 and t - start >= step_s / 4 and end - t >= step_s / 4:
            edges.append(t)
        t += step_s
    return sorted(edges)


def _merge_repeats(points: list[Point]) -> list[Point]:
    """Drops points that repeat the value before them: the step function stays the same."""
    out: list[Point] = []
    for p in points:
        if not out or out[-1][1] != p[1]:
            out.append(p)
    return out


def detail(
    points: list[Point], start: float, end: float, max_points: int, breaks: Iterable[float] = ()
) -> tuple[int | None, list[Point], list[Bounds] | None]:
    """The step function on [start, end) in at most about `max_points` points: (None, every change, None) when they
    fit, else (step, the means of the buckets from `detail_edges`, each bucket's lowest and highest value); each point
    holds until the next one, the last until `end`. A bucket without a mean has no bounds either."""
    clipped = _merge_repeats(clip_points(points, start, end))
    if len(clipped) <= max_points:
        return None, clipped, None
    step = pick_step(end - start, max_points)
    edges = detail_edges(start, end, step, breaks)
    means = bucket_means(clipped, edges)
    extremes = bucket_extremes(clipped, edges)
    shown: list[Point] = []
    bounds: list[Bounds] = []
    for a, (mean, _), ext in zip(edges[:-1], means, extremes, strict=True):
        ext = ext if mean is not None else (None, None)
        if shown and shown[-1][1] == mean and bounds[-1] == ext:
            continue
        shown.append((a, mean))
        bounds.append(ext)
    return step, shown, bounds
