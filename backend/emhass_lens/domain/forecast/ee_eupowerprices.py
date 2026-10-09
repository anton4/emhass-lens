"""eupowerprices.com EE day-ahead price forecast.

GET https://api.eupowerprices.com/v1/forecasts/EE/latest with header X-API-Key.
Body: {"series": [{"ts_utc": "...", "price_eur_mwh": 87.3}, ...], ...} with hourly points.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from emhass_lens.domain.forecast.base import ForecastSeries, with_resolution

PROVIDER = "ee_eupowerprices"
URL = "https://api.eupowerprices.com/v1/forecasts/EE/latest"


def _ts(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)


def parse(body: dict[str, Any], fetched_at: datetime) -> ForecastSeries:
    pairs: list[tuple[datetime, float]] = []
    for item in body.get("series") or []:
        ts, price = item.get("ts_utc"), item.get("price_eur_mwh")
        if ts is None or price is None:
            continue
        pairs.append((_ts(str(ts)), float(price)))
    issued = body.get("issued_at") or body.get("created_at") or body.get("generated_at")
    meta: dict[str, object] = {
        k: v for k, v in body.items() if k != "series" and isinstance(v, (str, int, float, bool))
    }
    return ForecastSeries(
        provider=PROVIDER,
        points=tuple(with_resolution(pairs, timedelta(hours=1))),
        fetched_at=fetched_at,
        issued_at=_ts(str(issued)) if issued else None,
        meta=meta,
    )
