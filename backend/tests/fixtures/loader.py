import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent


def load_json(*parts: str) -> Any:
    return json.loads(HERE.joinpath(*parts).read_text(encoding="utf-8"))


def nordpool(day: str) -> dict[str, Any]:
    return load_json("nordpool", f"np_EE_{day}.json")


def synthetic_nordpool(day: str, start_utc: datetime, slots: int, base: float = 50.0, step_min: int = 15,
                       state: str = "Final") -> dict[str, Any]:
    """A DayAheadPrices-shaped response, e.g. for DST days the API won't serve anymore."""
    entries = []
    for i in range(slots):
        start = start_utc + timedelta(minutes=step_min * i)
        entries.append({
            "deliveryStart": start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "deliveryEnd": (start + timedelta(minutes=step_min)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "entryPerArea": {"EE": round(base + (i % 37) * 3.17 - 20, 2)},
        })
    return {
        "deliveryDateCET": day, "version": 1, "updatedAt": "2026-01-01T12:00:00Z", "deliveryAreas": ["EE"],
        "market": "DayAhead", "multiAreaEntries": entries, "currency": "EUR", "exchangeRate": 1,
        "areaStates": [{"state": state, "areas": ["EE"]}],
    }
