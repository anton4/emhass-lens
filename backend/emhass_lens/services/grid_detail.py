"""The measured grid power at a finer step than the quarter-hour means, for the Plan page's Power chart: to set what
went through the grid connection beside the market's commands, and to say how much of each command was delivered.

The grid sensor's recorder history is read in whole hours and kept in memory (an hour is read once it has settled;
the current hour again after TAIL_TTL_S), so the chart's refresh reads only the tail from Home Assistant. Values are
kept as the sensor reported them; the scale and sign from Settings → Measurements are applied when they are served.
"""

import asyncio
import logging
import math
from array import array
from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso
from emhass_lens.domain.measure import Point, bucket_means, clip_points, detail, step_points
from emhass_lens.settings.model import MeasuredPower

if TYPE_CHECKING:
    from emhass_lens.container import Container
    from emhass_lens.domain.market import CommandSpan

log = logging.getLogger("emhass_lens.grid_detail")

HOUR_S = 3600
SETTLED_S = 120  # an hour that ended this long ago is complete in the recorder
TAIL_TTL_S = 30  # the hour still going is read again after this
MAX_HOURS = 72  # hours kept in memory
READ_HOURS = 6  # hours per recorder request; chatty power sensors make bigger answers heavy
WINDOW_MAX = timedelta(hours=48)
DELIVERED_TIMEOUT_S = 10.0
MIN_SPAN_S = 5.0  # shorter spans are the moment between two sensors changing, not a command
NO_SENSOR = "No grid power sensor (Settings → Measurements → Grid power)"


@dataclass
class _Hour:
    times: array[float]
    values: array[float]  # NaN for no value
    read_at: float
    complete: bool

    def points(self) -> list[Point]:
        return [(t, None if math.isnan(v) else v) for t, v in zip(self.times, self.values, strict=True)]


def _hour_floor(t: float) -> float:
    return math.floor(t / HOUR_S) * HOUR_S


def _hours(start: float, end: float) -> list[float]:
    out: list[float] = []
    h = _hour_floor(start)
    while h < end:
        out.append(h)
        h += HOUR_S
    return out


def _utc(t: float) -> datetime:
    return datetime.fromtimestamp(t, UTC)


class GridDetailService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self._cache: OrderedDict[tuple[str, float], _Hour] = OrderedDict()
        self._lock = asyncio.Lock()

    def _cfg(self) -> MeasuredPower | None:
        cfg = self.c.settings.current.measurements.grid
        return cfg if cfg.entity else None

    # --- the recorder, an hour at a time -------------------------------------------------------------------------
    def _fresh(self, entity: str, h: float, now: float) -> _Hour | None:
        hour = self._cache.get((entity, h))
        if hour is None or not (hour.complete or now - hour.read_at < TAIL_TTL_S):
            return None
        self._cache.move_to_end((entity, h))
        return hour

    async def _ensure(self, entity: str, hours: Iterable[float], now: float) -> None:
        """Reads the hours not in memory (or the current one, when stale), a few hours per request."""
        async with self._lock:
            missing = sorted(h for h in set(hours) if h < now and self._fresh(entity, h, now) is None)
            runs: list[list[float]] = []
            for h in missing:
                if runs and h - runs[-1][-1] == HOUR_S and len(runs[-1]) < READ_HOURS:
                    runs[-1].append(h)
                else:
                    runs.append([h])
            ha = self.c.extras["ha"]
            for run in runs:
                start, end = run[0], min(run[-1] + HOUR_S, now)
                lists = await ha.history(_utc(start), _utc(end), [entity], timeout=30)
                states = next(
                    (lst for lst in lists if lst and isinstance(lst[0], dict) and lst[0].get("entity_id") == entity),
                    [],
                )
                for h in run:
                    points = step_points(states, h, min(h + HOUR_S, now))
                    self._cache[(entity, h)] = _Hour(
                        times=array("d", (t for t, _ in points)),
                        values=array("d", (math.nan if v is None else v for _, v in points)),
                        read_at=now,
                        complete=h + HOUR_S <= now - SETTLED_S,
                    )
                    self._cache.move_to_end((entity, h))
            while len(self._cache) > MAX_HOURS:
                self._cache.popitem(last=False)

    async def _points(self, entity: str, start: float, end: float, now: float) -> list[Point]:
        """The sensor's step function on [start, end), as reported (no scale or sign)."""
        hours = _hours(start, end)
        await self._ensure(entity, hours, now)
        points: list[Point] = []
        for h in hours:
            hour = self._cache.get((entity, h))
            if hour is not None:
                points.extend(hour.points())
        return clip_points(points, start, end)

    # --- what the chart and the commands get ----------------------------------------------------------------------
    async def _breaks(self, start: datetime, end: datetime) -> list[float]:
        """Where the market's commands start, end or change power: the measured line breaks there too."""
        market = self.c.extras.get("market")
        if market is None:
            return []
        try:
            spans = await market.spans(start, end)
        except Exception as exc:  # the line is still worth drawing without them
            log.debug("Reading the market commands for the grid detail failed: %s", exc)
            return []
        return [t for s in spans for t in (s.start.timestamp(), s.end.timestamp())]

    async def detail(self, start: datetime, end: datetime, max_points: int) -> dict[str, Any]:
        """The measured grid power on [start, end) in at most about `max_points` points: every change when they fit,
        else means over a step that suits the window, broken where a market command starts, ends or changes."""
        cfg = self._cfg()
        out: dict[str, Any] = {
            "entity": cfg.entity if cfg else None,
            "start": iso(start),
            "end": iso(end),
            "step_s": None,
            "points": [],
            "error": None,
        }
        if cfg is None:
            out["error"] = NO_SENSOR
            return out
        a, b = start.timestamp(), end.timestamp()
        try:
            breaks = await self._breaks(start, end)
            points = await self._points(cfg.entity, a, b, self.c.clock.now().timestamp())
        except Exception as exc:  # the chart leaves the line out and says why
            log.debug("Reading the grid power history failed: %s", exc)
            out["error"] = str(exc)
            return out
        step, shown = detail(points, a, b, max_points, breaks)
        out["step_s"] = step
        out["points"] = [{"t": iso(_utc(t)), "w": round(cfg.to_emhass(v)) if v is not None else None} for t, v in shown]
        return out

    async def delivered(self, spans: list[CommandSpan]) -> tuple[list[tuple[int | None, float | None]], str | None]:
        """The measured grid power's mean (W, EMHASS's sign) and its coverage over each span, for the spans that
        ended within the last 48 h; (None, None) for the others, and when there's no grid sensor or the recorder
        couldn't be read (with why)."""
        out: list[tuple[int | None, float | None]] = [(None, None)] * len(spans)
        cfg = self._cfg()
        now_dt = self.c.clock.now()
        now = now_dt.timestamp()
        wanted = [
            i
            for i, s in enumerate(spans)
            if s.end > now_dt - WINDOW_MAX and (s.end - s.start).total_seconds() >= MIN_SPAN_S
        ]
        if cfg is None or not wanted:
            return out, None
        bounds = {i: (spans[i].start.timestamp(), min(spans[i].end.timestamp(), now)) for i in wanted}
        try:
            async with asyncio.timeout(DELIVERED_TIMEOUT_S):
                hours = {h for a, b in bounds.values() for h in _hours(a, b)}
                await self._ensure(cfg.entity, hours, now)
                for i, (a, b) in bounds.items():
                    if b <= a:
                        continue
                    points = await self._points(cfg.entity, a, b, now)
                    mean, coverage = bucket_means(points, [a, b])[0]
                    out[i] = (round(cfg.to_emhass(mean)) if mean is not None else None, coverage)
        except TimeoutError:
            log.debug("Reading the grid power for the market commands took over %.0f s", DELIVERED_TIMEOUT_S)
            return [(None, None)] * len(spans), "Reading the grid power history took too long"
        except Exception as exc:  # the commands are still shown, without what was delivered
            log.debug("Reading the grid power for the market commands failed: %s", exc)
            return [(None, None)] * len(spans), str(exc)
        return out, None
