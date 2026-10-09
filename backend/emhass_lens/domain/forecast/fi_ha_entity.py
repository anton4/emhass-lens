"""Finnish price forecast from the nordpool-predict-fi HA integration, read from an entity attribute:
forecast = [{"timestamp": "2026-10-10T00:00:00+03:00", "value": 6.42}, ...] (c/kWh by default)."""

from datetime import UTC, datetime, timedelta
from typing import Any

from emhass_lens.domain.forecast.base import ForecastSeries, with_resolution

PROVIDER = "fi_ha_entity"
TO_EUR_MWH = {"c_per_kwh": 10.0, "eur_per_kwh": 1000.0, "eur_per_mwh": 1.0}


def parse(
    attribute_value: Any, unit: str, vat_included_pct: float, fetched_at: datetime, entity_id: str
) -> ForecastSeries:
    factor = TO_EUR_MWH[unit] / (1.0 + vat_included_pct / 100.0)
    pairs: list[tuple[datetime, float]] = []
    for item in attribute_value or []:
        if not isinstance(item, dict):
            continue
        ts, value = item.get("timestamp"), item.get("value")
        if ts is None or value is None:
            continue
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            pairs.append((dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC), float(value) * factor))
        except ValueError:
            continue
    return ForecastSeries(
        provider=PROVIDER,
        points=tuple(with_resolution(pairs, timedelta(hours=1))),
        fetched_at=fetched_at,
        meta={"entity_id": entity_id, "unit": unit, "vat_included_pct": vat_included_pct},
    )
