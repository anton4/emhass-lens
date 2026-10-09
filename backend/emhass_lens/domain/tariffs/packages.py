"""Elektrilevi network packages (low voltage up to 63 A), electricity transmission rates in €/kWh
excluding VAT, from the price list valid from 1 June 2026 (same table as MFFR-Profit-Tracker's
fees.py, converted from cents). Monthly fees are fixed costs and don't affect planning."""

from dataclasses import dataclass


@dataclass(frozen=True)
class NetworkPackage:
    label: str
    note: str
    day: float
    night: float
    day_peak: float | None = None
    holiday_peak: float | None = None


PACKAGES: dict[str, NetworkPackage] = {
    "vork1": NetworkPackage("Elektrilevi Võrk 1", "One price around the clock", 0.0772, 0.0772),
    "vork2": NetworkPackage("Elektrilevi Võrk 2", "Day / night", 0.0607, 0.0351),
    "vork4": NetworkPackage("Elektrilevi Võrk 4", "Day / night, higher monthly fee", 0.0369, 0.0210),
    "vork5": NetworkPackage("Elektrilevi Võrk 5", "Day / night + winter peak hours", 0.0529, 0.0303, 0.0818, 0.0474),
}
