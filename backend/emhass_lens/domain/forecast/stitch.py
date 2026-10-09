"""Joins actual day-ahead prices with a forecast into one 15-minute series.

Forecast slots start where the actual prices end and stop `extend_days` later. Each forecast point
is split into 15-minute slots; a slot is taken from the forecast point it starts in.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from itertools import pairwise

from emhass_lens.domain.forecast.base import ForecastSeries
from emhass_lens.domain.nordpool import PriceEntry

QUARTER = timedelta(minutes=15)


@dataclass(frozen=True, slots=True)
class SpotSlot:
    start: datetime
    end: datetime
    eur_mwh: float
    origin: str  # "actual" | "forecast:<provider>"


@dataclass(frozen=True)
class Stitched:
    slots: tuple[SpotSlot, ...]
    actual_end: datetime | None
    forecast_until: datetime | None
    gaps: tuple[tuple[datetime, datetime], ...]  # holes inside the actual prices


def stitch(actual: list[PriceEntry], forecast: ForecastSeries | None, extend_days: int) -> Stitched:
    actual = sorted(actual, key=lambda e: e.start)
    slots = [SpotSlot(e.start, e.end, e.eur_mwh, "actual") for e in actual]
    gaps = tuple((prev.end, cur.start) for prev, cur in pairwise(actual) if cur.start > prev.end)
    actual_end = actual[-1].end if actual else None
    forecast_until = None
    if forecast is not None and forecast.points and actual_end is not None:
        cutoff = actual_end + timedelta(days=extend_days)
        origin = f"forecast:{forecast.provider}"
        for point in forecast.points:
            if point.end <= actual_end or point.start >= cutoff:
                continue
            start = point.start
            while start < point.end:
                if actual_end <= start < cutoff:
                    slots.append(SpotSlot(start, start + QUARTER, point.eur_mwh, origin))
                    forecast_until = start + QUARTER
                start += QUARTER
    slots.sort(key=lambda s: s.start)
    return Stitched(tuple(slots), actual_end, forecast_until, gaps)
