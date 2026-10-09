"""Turns a spot price into what a slot really costs to import and pays to export (Estonia).

    tariff_ex_vat = margin + renewable + excise + balancing + supply_security + network(period)
    import        = (spot + tariff_ex_vat) × (1 + VAT)
    export        = spot − export_margin − export_balancing          (no VAT)

The network period is decided per 15-minute slot from its local start time:
- night: weekends, Estonian public holidays and the night window (22–07 by default);
- day peak / weekend peak: November–March only, when the package has peak rates
  (working days 09–12 and 16–20; weekends and holidays 16–20);
- day: everything else.

Every result carries its components and the reason for the period, so the UI can show why a slot
costs what it costs. legacy_compat reproduces the HACS integration exactly (for parity checks).
"""

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from emhass_lens.domain.tariffs.holidays import holiday_name
from emhass_lens.domain.tariffs.packages import PACKAGES
from emhass_lens.settings.model import Tariff

WINTER_MONTHS = {11, 12, 1, 2, 3}


@dataclass(frozen=True, slots=True)
class NetworkRates:
    day: float
    night: float
    day_peak: float | None
    holiday_peak: float | None


@dataclass(frozen=True, slots=True)
class SlotPrice:
    start: datetime  # UTC
    end: datetime
    spot: float  # €/kWh, as used (rounded in legacy mode)
    origin: str  # "actual" or "forecast:<provider>"
    period: str  # day | night | day_peak | holiday_peak
    reason: str
    margin: float
    renewable: float
    excise: float
    balancing: float
    supply_security: float
    network: float
    tariff_ex_vat: float
    vat: float  # € of VAT in the import price
    import_price: float
    export_fees: float
    export_price: float

    @property
    def is_forecast(self) -> bool:
        return self.origin != "actual"


def network_rates(tariff: Tariff) -> NetworkRates:
    package = PACKAGES.get(tariff.package)
    if package is not None:
        return NetworkRates(package.day, package.night, package.day_peak, package.holiday_peak)
    net = tariff.network
    return NetworkRates(net.day, net.night, net.day_peak, net.holiday_peak)


def _hhmm(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


def _in_window(clock: time, start: time, end: time) -> bool:
    if start <= end:
        return start <= clock < end
    return clock >= start or clock < end  # wraps midnight, e.g. 22:00–07:00


def network_period(slot_start: datetime, tariff: Tariff, rates: NetworkRates, tz: ZoneInfo) -> tuple[str, str]:
    """(period, human reason) for a slot by its local start time."""
    local = slot_start.astimezone(tz)
    holiday = holiday_name(local.date())
    weekend = local.weekday() >= 5
    rest_day = weekend or holiday is not None
    winter = local.month in WINTER_MONTHS
    hour = local.hour

    if winter and rest_day and rates.holiday_peak and 16 <= hour < 20:
        return "holiday_peak", "weekend peak 16–20 (Nov–Mar)" if weekend else f"holiday peak 16–20: {holiday}"
    if winter and not rest_day and rates.day_peak and (9 <= hour < 12 or 16 <= hour < 20):
        return "day_peak", "day peak 09–12 / 16–20 (Nov–Mar)"
    if holiday is not None:
        return "night", f"holiday: {holiday}"
    if weekend:
        return "night", "weekend"

    window = tariff.night_window
    clock = local.timetz().replace(tzinfo=None)
    label = f"night {window.start}–{window.end}"
    if window.clock_basis == "standard_time":
        dst = local.dst() or timedelta(0)
        clock = (datetime.combine(local.date(), clock) - dst).time()
        if dst:
            label += " winter time"
    if _in_window(clock, _hhmm(window.start), _hhmm(window.end)):
        return "night", label
    return "day", "day"


def price_slot(
    spot_eur_mwh: float,
    start: datetime,
    end: datetime,
    tariff: Tariff,
    tz: ZoneInfo,
    origin: str = "actual",
    rates: NetworkRates | None = None,
    legacy_compat: bool = False,
) -> SlotPrice:
    rates = rates or network_rates(tariff)
    if legacy_compat:
        spot = round(spot_eur_mwh / 1000.0, 3) if origin == "actual" else round(spot_eur_mwh / 1000.0, 5)
        local = start.astimezone(tz)
        night = (
            local.weekday() in (5, 6) or local.hour < 7 or local.hour >= 22 or holiday_name(local.date()) is not None
        )
        period, reason = ("night", "legacy night rule") if night else ("day", "legacy day rule")
    else:
        spot = spot_eur_mwh / 1000.0
        period, reason = network_period(start, tariff, rates, tz)

    network = {
        "day": rates.day,
        "night": rates.night,
        "day_peak": rates.day_peak or rates.day,
        "holiday_peak": rates.holiday_peak or rates.night,
    }[period]
    tariff_ex_vat = (
        tariff.margin + tariff.renewable + tariff.excise + tariff.balancing + tariff.supply_security + network
    )
    vat_factor = 1.0 + tariff.vat_pct / 100.0
    import_price = (spot + tariff_ex_vat) * vat_factor
    export_fees = tariff.export_margin + tariff.export_balancing
    export_price = spot - export_fees
    if legacy_compat:
        import_price = round(import_price, 5)
        export_price = round(export_price, 5)
    return SlotPrice(
        start=start,
        end=end,
        spot=spot,
        origin=origin,
        period=period,
        reason=reason,
        margin=tariff.margin,
        renewable=tariff.renewable,
        excise=tariff.excise,
        balancing=tariff.balancing,
        supply_security=tariff.supply_security,
        network=network,
        tariff_ex_vat=tariff_ex_vat,
        vat=(spot + tariff_ex_vat) * (vat_factor - 1.0),
        import_price=import_price,
        export_fees=export_fees,
        export_price=export_price,
    )
