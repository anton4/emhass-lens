from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from emhass_lens.domain import nordpool
from emhass_lens.domain.forecast import ee_eupowerprices, fi_ha_entity
from emhass_lens.domain.forecast.stitch import stitch
from emhass_lens.domain.pv_solcast import day_sensors
from emhass_lens.domain.pv_solcast import parse as parse_pv
from emhass_lens.domain.tariffs.engine import price_slot
from emhass_lens.settings.model import Tariff
from tests.fixtures.loader import nordpool as np_fixture
from tests.legacy import legacy_math

TZ = ZoneInfo("Europe/Tallinn")
NOW = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)


def actual_entries() -> list[nordpool.PriceEntry]:
    entries: list[nordpool.PriceEntry] = []
    for day in ("2026-10-09", "2026-10-10"):
        entries += nordpool.parse(np_fixture(day), date.fromisoformat(day), "EE").entries
    return entries


def ee_body(start: datetime, hours: int) -> dict:
    return {
        "series": [
            {"ts_utc": (start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ"), "price_eur_mwh": 40 + h * 1.5}
            for h in range(hours)
        ],
        "issued_at": "2026-10-09T10:00:00Z",
    }


def test_stitch_matches_legacy_append_forecast() -> None:
    actual = actual_entries()
    series = ee_eupowerprices.parse(ee_body(datetime(2026, 10, 10, 12, 0, tzinfo=UTC), 72), NOW)
    stitched = stitch(actual, series, extend_days=1)
    assert stitched.actual_end == datetime(2026, 10, 10, 22, 0, tzinfo=UTC)
    assert stitched.forecast_until == datetime(2026, 10, 11, 22, 0, tzinfo=UTC)
    forecast_slots = [s for s in stitched.slots if s.origin != "actual"]
    assert len(forecast_slots) == 96

    # legacy: actual price dict (local ISO) + hourly (local start, €/kWh) tuples
    legacy_raw = []
    for day in ("2026-10-09", "2026-10-10"):
        legacy_raw += legacy_math.price_dict_from_response(np_fixture(day)).values()
    legacy_raw.sort(key=lambda p: p["start"])
    hourly = [(p.start.astimezone(TZ), round(p.eur_mwh / 1000, 5)) for p in series.points]
    merged = legacy_math.append_forecast(legacy_raw, hourly, 1)
    legacy_forecast = [p for p in merged if p.get("is_forecast")]
    assert [p["start"] for p in legacy_forecast] == [s.start.astimezone(TZ).isoformat() for s in forecast_slots]
    tariff = Tariff()
    ours = [price_slot(s.eur_mwh, s.start, s.end, tariff, TZ, s.origin, legacy_compat=True) for s in stitched.slots]
    legacy_import = legacy_math.calculated_prices(merged, "import", legacy_math.LEGACY_DEFAULT_OPTS)
    assert [p.import_price for p in ours] == [p["value"] for p in legacy_import]


def test_fi_forecast_units_and_vat_removal() -> None:
    attr = [
        {"timestamp": "2026-10-11T00:00:00+03:00", "value": 6.2},
        {"timestamp": "2026-10-11T01:00:00+03:00", "value": 5.0},
    ]
    series = fi_ha_entity.parse(attr, "c_per_kwh", 25.5, NOW, "sensor.nordpool_predict_fi_price")
    assert series.points[0].start == datetime(2026, 10, 10, 21, 0, tzinfo=UTC)
    assert series.points[0].eur_mwh == 62.0 / 1.255
    assert series.points[1].end - series.points[1].start == timedelta(hours=1)


def solcast_day(local_day: date, kw: float = 2.0, periods: int = 48) -> dict:
    start = datetime(local_day.year, local_day.month, local_day.day, tzinfo=TZ)
    return {
        "detailedForecast": [
            {
                "period_start": (start + timedelta(minutes=30 * i)).isoformat(),
                "pv_estimate": round(kw * (i % 7) / 3.3, 4),
                "pv_estimate10": 0.5,
            }
            for i in range(periods)
        ]
    }


def test_pv_matches_legacy_on_a_normal_day() -> None:
    days = [date(2026, 10, 9) + timedelta(days=i) for i in range(3)]
    attrs = [solcast_day(d) for d in days]
    sensors = day_sensors("sensor.solcast_pv_forecast_forecast_", 3)
    pv = parse_pv({sid: {"attributes": a} for sid, a in zip(sensors, attrs, strict=True)}, "estimate")
    now_local = datetime(2026, 10, 9, 14, 3, tzinfo=TZ)
    current = now_local.astimezone(UTC).replace(minute=0)  # 11:00Z = 14:00 local
    starts = [current + timedelta(minutes=15 * i) for i in range(100)]
    ours, missing = pv.series(starts)
    legacy = legacy_math.solcast_values(attrs, "estimate", 100, now_local)
    assert missing == []
    assert all(abs(a - b) <= 1 for a, b in zip(ours, legacy, strict=True))  # legacy truncates with int()


def test_pv_missing_day_does_not_shift_later_days() -> None:
    sensors = day_sensors("sensor.solcast_pv_forecast_forecast_", 3)
    states = {
        sensors[0]: {"attributes": solcast_day(date(2026, 10, 9), 1.0)},
        sensors[1]: None,  # tomorrow's sensor unavailable
        sensors[2]: {"attributes": solcast_day(date(2026, 10, 11), 3.0)},
    }
    pv = parse_pv(states, "estimate")
    assert pv.sensors_missing == (sensors[1],)
    day3_noon = datetime(2026, 10, 11, 12, 0, tzinfo=TZ).astimezone(UTC)
    assert pv.watts[day3_noon] == solcast_day(date(2026, 10, 11), 3.0)["detailedForecast"][24]["pv_estimate"] * 1000
    _, missing = pv.series([datetime(2026, 10, 10, 12, 0, tzinfo=TZ).astimezone(UTC)])
    assert len(missing) == 1


def test_pv_dst_day_with_50_periods_stays_aligned() -> None:
    # 2026-10-25 local day is 25 h long: 50 half-hour periods
    day = date(2026, 10, 25)
    start_utc = datetime(2026, 10, 24, 21, 0, tzinfo=UTC)  # local midnight EEST
    periods = [
        {"period_start": (start_utc + timedelta(minutes=30 * i)).isoformat(), "pv_estimate": i / 10} for i in range(50)
    ]
    pv = parse_pv({"s": {"attributes": {"detailedForecast": periods}}}, "estimate")
    last_local_hour = datetime(2026, 10, 25, 23, 30, tzinfo=TZ).astimezone(UTC)
    assert pv.watts[last_local_hour] == 49 / 10 * 1000
    assert day == last_local_hour.astimezone(TZ).date()
