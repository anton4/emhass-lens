"""The HACS integration's price and payload math, copied with only Home Assistant removed.

Source: anton4/homeassistant-ee-nordpool, custom_components/homeassistant-ee-nordpool,
coordinator.py:452-468 (price_dict), sensor.py:97-174 (_append_forecast, _get_calculated_prices),
sensor.py:269-360 (prices from now, Solcast) and __init__.py:119-178 (MPC payload).
Used as the reference in golden tests: EMHASS Lens with legacy_compat must reproduce it exactly.
"""

from collections.abc import Sequence
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import holidays

TZ = ZoneInfo("Europe/Tallinn")


def parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value)


def as_local(dt: datetime) -> datetime:
    return dt.astimezone(TZ)


def price_dict_from_response(data: dict) -> dict:
    """coordinator.py: multiAreaEntries -> {local_start_iso: {start, end, value}} (€/kWh, 3 dp)."""
    out = {}
    for entry in data.get("multiAreaEntries", []):
        val = entry.get("entryPerArea", {}).get("EE")
        if val is None:
            continue
        start = as_local(parse_datetime(entry["deliveryStart"].replace("Z", "+00:00")))
        end = as_local(parse_datetime(entry["deliveryEnd"].replace("Z", "+00:00")))
        out[start.isoformat()] = {"start": start.isoformat(), "end": end.isoformat(), "value": round(val / 1000, 3)}
    return out


def append_forecast(raw_prices: list[dict], hourly: list[tuple[datetime, float]], extend_days: int) -> list[dict]:
    merged = list(raw_prices)
    ee_end_dt = parse_datetime(merged[-1]["end"])
    cutoff_dt = ee_end_dt + timedelta(days=extend_days)
    for start_dt, value_eur in hourly:
        hour_end_dt = start_dt + timedelta(hours=1)
        if hour_end_dt <= ee_end_dt:
            continue
        if start_dt >= cutoff_dt:
            continue
        for i in range(4):
            block_start = start_dt + timedelta(minutes=15 * i)
            block_end = block_start + timedelta(minutes=15)
            if block_start >= ee_end_dt and block_start < cutoff_dt:
                merged.append(
                    {
                        "start": block_start.isoformat(),
                        "end": block_end.isoformat(),
                        "value": round(value_eur, 5),
                        "is_forecast": True,
                    }
                )
    return merged


def calculated_prices(raw_prices: list[dict], price_type: str, opts: dict) -> list[dict]:
    ee_holidays = holidays.country_holidays("EE")
    out = []
    for p in raw_prices:
        start_dt = parse_datetime(p["start"])
        if price_type == "import":
            is_weekend = start_dt.weekday() in (5, 6)
            is_night_hour = start_dt.hour < 7 or start_dt.hour >= 22
            is_holiday = start_dt.date() in ee_holidays
            base = opts["margin"] + opts["taastuv"] + opts["aktsiis"] + opts["tasakaal"] + opts["varustus"]
            tariff = base + (
                opts["elektrilevi_night"] if (is_weekend or is_night_hour or is_holiday) else opts["elektrilevi_day"]
            )
            final_value = (p["value"] + tariff) * (1.0 + (opts["vat"] / 100.0))
        else:
            final_value = p["value"] - opts["export_margin"] - opts["export_tasakaal"]
        out.append(
            {
                "start": p["start"],
                "end": p["end"],
                "value": round(final_value, 5),
                "is_forecast": p.get("is_forecast", False),
            }
        )
    return out


def prices_from_now(raw_prices: list[dict], opts: dict, now: datetime) -> dict:
    imports = [p["value"] for p in calculated_prices(raw_prices, "import", opts) if parse_datetime(p["end"]) > now]
    exports = [p["value"] for p in calculated_prices(raw_prices, "export", opts) if parse_datetime(p["end"]) > now]
    return {"timestamps_left": len(imports), "import_prices": imports, "export_prices": exports}


def solcast_values(day_attrs: Sequence[dict | None], field_name: str, np_range: int, now: datetime) -> list[int]:
    raw = []
    for attrs in day_attrs:
        if attrs and "detailedForecast" in attrs:
            raw.extend(item.get(f"pv_{field_name}", 0.0) for item in attrs["detailedForecast"])
    values = []
    for val in raw:
        watts = int(float(val) * 1000)
        values.extend([watts, watts])
    start = now.hour * 4 + now.minute // 15
    sliced = values[start : start + np_range]
    while len(sliced) < np_range:
        sliced.append(0)
    return sliced


def mpc_payload(
    from_now: dict,
    pv: list[int],
    soc_init: float,
    soc_final: float,
    now: datetime,
    extend_days: int,
    ev: dict | None = None,
) -> dict:
    ev = ev or {"enabled": False}
    load_cost = [round(p, 4) for p in from_now["import_prices"]]
    prod_price = [round(p, 4) for p in from_now["export_prices"]]
    timestamps_left = from_now["timestamps_left"]
    pv = list(pv)
    if (now.minute % 15) * 60 + now.second > 450:
        load_cost, prod_price, pv = load_cost[1:], prod_price[1:], pv[1:]
        timestamps_left = max(0, int(timestamps_left) - 1)
    lags = 192 + extend_days * 96
    return {
        "load_cost_forecast": load_cost,
        "prod_price_forecast": prod_price,
        "prediction_horizon": timestamps_left,
        "pv_power_forecast": pv,
        "load_forecast_method": "mlforecaster",
        "var_model": "sensor.house_power_without_deferrable",
        "num_lags": lags,
        "historic_days_to_retrieve": max(7, int((lags / 96) + 2)),
        "delta_forecast_daily": 2 + extend_days,
        "soc_init": soc_init,
        "soc_final": soc_final,
        "number_of_deferrable_loads": 1,
        "nominal_power_of_deferrable_loads": [11000] if ev["enabled"] else [0],
        "operating_hours_of_each_deferrable_load": [float(ev.get("hours", 0))] if ev["enabled"] else [0],
        "end_timesteps_of_each_deferrable_load": [int(ev.get("timesteps", 0))] if ev["enabled"] else [0],
        "set_deferrable_load_single_constant": [bool(ev.get("force", False))],
    }


LEGACY_DEFAULT_OPTS = {
    "margin": 0.00328,
    "taastuv": 0.0084,
    "aktsiis": 0.0021,
    "tasakaal": 0.00373,
    "varustus": 0.00758,
    "elektrilevi_day": 0.0369,
    "elektrilevi_night": 0.021,
    "vat": 24.0,
    "export_margin": 0.01,
    "export_tasakaal": 0.00373,
}
