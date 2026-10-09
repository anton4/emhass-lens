"""Seed the e2e Home Assistant with Solcast-like day sensors (states set over REST; gone after a restart)."""

import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx

TZ = ZoneInfo("Europe/Tallinn")


def main(token: str) -> None:
    today = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    with httpx.Client(base_url="http://localhost:18123", headers={"Authorization": f"Bearer {token}"}) as http:
        for i, suffix in enumerate(("today", "tomorrow", "day_3", "day_4", "day_5", "day_6", "day_7")):
            start = today + timedelta(days=i)
            periods = []
            for h in range(48):
                kw = max(0.0, 6.0 * (1 - abs(h - 26) / 10))
                periods.append(
                    {
                        "period_start": (start + timedelta(minutes=30 * h)).isoformat(),
                        "pv_estimate": round(kw, 4),
                        "pv_estimate10": round(kw * 0.6, 4),
                        "pv_estimate90": round(kw * 1.2, 4),
                    }
                )
            http.post(
                f"/api/states/sensor.solcast_pv_forecast_forecast_{suffix}",
                json={"state": "10", "attributes": {"detailedForecast": periods, "unit_of_measurement": "kWh"}},
            ).raise_for_status()
        http.post("/api/states/select.solcast_pv_forecast_use_forecast_field", json={"state": "estimate"})
    print("seeded Solcast sensors")


if __name__ == "__main__":
    main(sys.argv[1])
