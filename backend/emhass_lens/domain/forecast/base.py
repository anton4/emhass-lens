"""Price forecasts that extend the horizon beyond the published day-ahead prices."""

from dataclasses import dataclass, field
from datetime import datetime, timedelta


@dataclass(frozen=True, slots=True)
class ForecastPoint:
    start: datetime  # UTC
    end: datetime
    eur_mwh: float  # spot-equivalent, excluding VAT


@dataclass(frozen=True)
class ForecastSeries:
    provider: str  # ee_eupowerprices | fi_ha_entity
    points: tuple[ForecastPoint, ...]
    fetched_at: datetime
    issued_at: datetime | None = None
    meta: dict[str, object] = field(default_factory=dict)

    @property
    def end(self) -> datetime | None:
        return self.points[-1].end if self.points else None


def with_resolution(starts_values: list[tuple[datetime, float]], default: timedelta) -> list[ForecastPoint]:
    """Points from (start, value) pairs; each point lasts until the next one (or `default` for the last)."""
    ordered = sorted(starts_values, key=lambda sv: sv[0])
    points: list[ForecastPoint] = []
    for i, (start, value) in enumerate(ordered):
        if i + 1 < len(ordered):
            step = ordered[i + 1][0] - start
            length = step if timedelta(0) < step <= default else default
        else:
            length = default
        points.append(ForecastPoint(start, start + length, value))
    return points
