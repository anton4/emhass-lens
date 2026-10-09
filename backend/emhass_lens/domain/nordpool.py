"""Nord Pool day-ahead prices: request addressing and response parsing.

The dataportal API addresses a *delivery day in CET/CEST* (Europe/Oslo time). For Estonia
(EET/EEST, one hour ahead) the local day D therefore spans two delivery days: 00:00–01:00 local
belongs to delivery day D−1 and the rest to D. All slots are kept in UTC.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

CET = ZoneInfo("Europe/Oslo")  # the delivery-day clock of the Nord Pool day-ahead market
API_URL = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices"


@dataclass(frozen=True, slots=True)
class PriceEntry:
    start: datetime  # UTC
    end: datetime  # UTC
    eur_mwh: float


@dataclass(frozen=True, slots=True)
class DeliveryDay:
    day: date  # CET delivery date
    state: str  # Final | Preliminary | Unknown
    entries: tuple[PriceEntry, ...]
    resolution_min: int | None
    currency: str | None
    updated_at: str | None


def request_params(day: date, area: str, currency: str = "EUR") -> dict[str, str]:
    return {"date": day.isoformat(), "market": "DayAhead", "deliveryArea": area, "currency": currency}


def delivery_day_of(moment: datetime) -> date:
    return moment.astimezone(CET).date()


def delivery_days_covering(start: datetime, end: datetime) -> list[date]:
    """The CET delivery days needed to cover [start, end)."""
    first = delivery_day_of(start)
    last = delivery_day_of(end - timedelta(microseconds=1))
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]


def _parse_ts(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)


def parse(body: dict[str, Any], day: date, area: str) -> DeliveryDay:
    """Parse a DayAheadPrices response. Entries without a price for the area are skipped."""
    entries: list[PriceEntry] = []
    for item in body.get("multiAreaEntries") or []:
        value = (item.get("entryPerArea") or {}).get(area)
        if value is None:
            continue
        entries.append(PriceEntry(_parse_ts(item["deliveryStart"]), _parse_ts(item["deliveryEnd"]), float(value)))
    entries.sort(key=lambda e: e.start)

    state = "Unknown"
    for area_state in body.get("areaStates") or []:
        if area in (area_state.get("areas") or []):
            state = str(area_state.get("state") or "Unknown")
            break

    resolution = None
    if entries:
        resolution = int((entries[0].end - entries[0].start).total_seconds() // 60)
    return DeliveryDay(
        day=day,
        state=state,
        entries=tuple(entries),
        resolution_min=resolution,
        currency=body.get("currency"),
        updated_at=body.get("updatedAt"),
    )


def to_quarter_hours(entries: tuple[PriceEntry, ...] | list[PriceEntry]) -> list[PriceEntry]:
    """Split hourly (or 30-min) entries into 15-minute slots with the same price."""
    out: list[PriceEntry] = []
    quarter = timedelta(minutes=15)
    for entry in entries:
        start = entry.start
        while start < entry.end:
            out.append(PriceEntry(start, min(start + quarter, entry.end), entry.eur_mwh))
            start += quarter
    return out
