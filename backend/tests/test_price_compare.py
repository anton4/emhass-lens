"""The App's priced slots against a Home Assistant price sensor (domain/price_compare.py)."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from emhass_lens.domain.price_compare import Interval, compare, explain, sensor_intervals
from emhass_lens.domain.tariffs.engine import network_rates, price_slot
from emhass_lens.domain.tariffs.packages import PACKAGES
from emhass_lens.settings.model import Tariff

TZ = ZoneInfo("Europe/Tallinn")
T0 = datetime(2026, 10, 9, 3, 0, tzinfo=UTC)  # 06:00 local on a Friday: one night hour, then day slots


def flat_slots(tariff: Tariff, hours: int = 4, origin: str = "actual", spot: float = 0.05):
    rates = network_rates(tariff)
    out = []
    for i in range(hours * 4):
        start = T0 + timedelta(minutes=15 * i)
        out.append(price_slot(spot, start, start + timedelta(minutes=15), tariff, TZ, origin, rates))
    return out


def hourly_from(slots, field: str, bump=lambda slot: 0.0) -> list[Interval]:
    out = []
    for h in range(len(slots) // 4):
        slot = slots[h * 4]
        value = round(float(getattr(slot, field)) + bump(slot), 4)
        out.append(Interval(slot.start, slot.start + timedelta(hours=1), value))
    return out


def test_sensor_intervals_reads_raw_all_or_today_plus_tomorrow() -> None:
    attrs = {
        "raw_today": [{"start": "2026-10-09T06:00:00+0300", "end": "2026-10-09T07:00:00+0300", "value": 0.1}],
        "raw_tomorrow": [
            {"start": "2026-10-10T06:00:00+0300", "end": "2026-10-10T07:00:00+0300", "value": None},
            {"start": "2026-10-10T07:00:00+0300", "end": "2026-10-10T08:00:00+0300", "value": 0.2},
        ],
    }
    got = sensor_intervals(attrs)
    assert [i.value for i in got] == [0.1, 0.2]
    assert got[0].start == datetime(2026, 10, 9, 3, 0, tzinfo=UTC)
    assert sensor_intervals({"raw_all": [{"start": "x", "end": "y", "value": 1}]}) == []
    assert sensor_intervals(None) == []


def test_hourly_intervals_compare_against_four_slots_each() -> None:
    tariff = Tariff()
    ours = flat_slots(tariff, hours=2)
    section = compare("sensor.x", hourly_from(ours, "import_price"), ours, "import_price", tolerance=0.0001)
    assert section["ok"] is True and section["compared"] == 8 and section["period_deltas"] == {}
    # a sensor that is 1 cent high in one hour
    theirs = hourly_from(ours, "import_price", lambda slot: 0.01 if slot.start == T0 else 0.0)
    section = compare("sensor.x", theirs, ours, "import_price", 0.0001)
    assert section["different"] == 4 and section["ok"] is False
    assert (
        section["examples"][0]["slot"] == "2026-10-09T03:00:00.000+00:00"
        and abs(section["examples"][0]["delta"] + 0.01) < 0.0002  # the sensor rounds to 4 decimals
    )


def test_forecast_slots_are_skipped_and_unknown_intervals_counted() -> None:
    tariff = Tariff()
    ours = flat_slots(tariff, hours=1, origin="forecast:ee")
    theirs = [*hourly_from(ours, "import_price"), Interval(T0 + timedelta(hours=5), T0 + timedelta(hours=6), 0.3)]
    section = compare("sensor.x", theirs, ours, "import_price", 0.0001)
    assert section["compared"] == 0 and section["skipped_forecast"] == 4
    assert section["legacy_slots_without_ours"] == 1 and section["ok"] is False


def test_explain_names_the_other_elektrilevi_package() -> None:
    tariff = Tariff()  # custom rates equal to Võrk 4 (3.69 / 2.10 c)
    ours = flat_slots(tariff, hours=4)
    vat = 1 + tariff.vat_pct / 100
    v2, mine = PACKAGES["vork2"], network_rates(tariff)

    def vork2(slot) -> float:
        return (v2.night - mine.night if slot.period == "night" else v2.day - mine.day) * vat

    section = compare("sensor.nordpool_import", hourly_from(ours, "import_price", vork2), ours, "import_price", 0.0001)
    assert section["ok"] is False and section["different"] == 16
    assert set(section["period_deltas"]) == {"night", "day"}
    note = explain(section, tariff, "import_price", 0.0001)
    assert note is not None and "Võrk 2" in note and "lower in EMHASS Lens" in note, note
    # differences that vary from hour to hour are not explained
    noisy = hourly_from(ours, "import_price", lambda slot: 0.01 * (slot.start.hour % 3 + 1))
    section = compare("sensor.nordpool_import", noisy, ours, "import_price", 0.0001)
    assert explain(section, tariff, "import_price", 0.0001) is None


def test_explain_export_fees() -> None:
    tariff = Tariff()
    ours = flat_slots(tariff, hours=2)
    theirs = hourly_from(ours, "export_price", lambda slot: 0.005)
    section = compare("sensor.nordpool_export", theirs, ours, "export_price", 0.0001)
    note = explain(section, tariff, "export_price", 0.0001)
    assert note is not None and "export fees" in note and "0.50 c lower" in note


def test_the_sensor_s_rounded_spot_price_is_not_a_difference() -> None:
    """The HA Nord Pool integration rounds the spot to 3 decimals: 1.871 c becomes 1.9 c (owner's 00:00 slot)."""
    tariff = Tariff()
    ours = flat_slots(tariff, hours=2, spot=18.71)  # €/MWh
    rounded = flat_slots(tariff, hours=2, spot=19.0)  # what the sensor's template starts from
    export = hourly_from(rounded, "export_price")  # rounded to 4 decimals like the template
    plain = compare("sensor.e", export, ours, "export_price", 0.0001)
    assert plain["different"] == 8  # 0.29 c apart before rounding our spot
    section = compare("sensor.e", export, ours, "export_price", 0.0001, spot_decimals=3)
    assert section["ok"] is True and section["equal"] == 8 and section["spot_decimals"] == 3
    vat = 1 + tariff.vat_pct / 100
    imports = [Interval(i.start, i.end, float(r.import_price)) for i, r in zip(export, rounded[::4], strict=True)]
    assert compare("sensor.i", imports, ours, "import_price", 0.0001, spot_decimals=3, vat_factor=vat)["ok"] is True
    # the rounding reaches the import price with VAT: 0.029 c × 1.24, not 0.029 c
    assert compare("sensor.i", imports, ours, "import_price", 0.00005, spot_decimals=3)["ok"] is False
