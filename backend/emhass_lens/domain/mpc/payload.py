"""Builds the naive-mpc-optim runtime parameters from timestamped inputs.

Everything stays timestamped until here; the lists EMHASS gets are positional, starting at the
anchor slot. The Explain table maps every position back to its slot, so a payload can be checked
by eye against prices and the PV forecast.
"""

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from emhass_lens.domain.issues import Issue
from emhass_lens.domain.mpc.anchor import slot_offset
from emhass_lens.domain.mpc.inputs import MpcInputs
from emhass_lens.settings.model import Settings

PRICE_DECIMALS = 4


@dataclass(frozen=True)
class Derived:
    """Values computed from settings, with the formula shown to the user."""

    extend_days: int
    num_lags: int
    num_lags_formula: str
    historic_days_to_retrieve: int
    delta_forecast_daily: int


@dataclass(frozen=True)
class BuildResult:
    payload: dict[str, Any]
    explain: list[dict[str, Any]]
    anchor: datetime
    horizon: int
    derived: Derived
    issues: list[Issue] = field(default_factory=list)


def derive(settings: Settings) -> Derived:
    """Same formulas as the HACS integration, so a model fitted by it keeps working."""
    extend = settings.forecast.extend_days if settings.forecast.source != "none" else 0
    if settings.emhass.ml.num_lags:
        lags, formula = settings.emhass.ml.num_lags, "set in Settings"
    else:
        lags, formula = 192 + 96 * extend, f"192 + 96 × {extend} forecast day(s)"
    return Derived(
        extend_days=extend,
        num_lags=lags,
        num_lags_formula=formula,
        historic_days_to_retrieve=max(7, int(lags / 96 + 2)),
        delta_forecast_daily=2 + extend,
    )


def build(inputs: MpcInputs, anchor: datetime, current_slot: datetime, settings: Settings) -> BuildResult:
    issues: list[Issue] = []
    derived = derive(settings)
    mpc = settings.emhass.mpc

    slots = [p for p in inputs.prices if p.start >= anchor]
    if slots and slots[0].start != anchor:
        issues.append(
            Issue(
                "error",
                "anchor_not_covered",
                f"Prices start at {slots[0].start.isoformat()}, after the anchor slot {anchor.isoformat()}",
            )
        )
    contiguous = []
    expected = anchor
    for slot in slots:
        if slot.start != expected:
            break
        contiguous.append(slot)
        expected = slot.end
    if len(contiguous) < len(slots):
        issues.append(
            Issue(
                "warning",
                "price_gap",
                f"Prices have a gap at {expected.isoformat()}; the horizon stops there",
            )
        )
    slots = contiguous[: mpc.max_horizon]
    starts = [s.start for s in slots]

    if inputs.pv is not None:
        pv_values, pv_missing = inputs.pv.series(starts)
        if pv_missing:
            share = len(pv_missing) / max(1, len(starts))
            level = "warning" if share < 0.5 else "error"
            issues.append(
                Issue(
                    level,
                    "pv_coverage",
                    f"PV forecast missing for {len(pv_missing)} of {len(starts)} slots (sent as 0 W), "
                    f"first at {pv_missing[0].isoformat()}",
                    hint="Check the Solcast day sensors on the Inputs page.",
                )
            )
    else:
        pv_values = [0.0] * len(starts)

    offset = slot_offset(anchor, current_slot)
    nominal, hours, ends, single = [], [], [], []
    for load in inputs.deferrables:
        on = bool(load.enabled.value)
        nominal.append(load.nominal_power_w if on else 0)
        op_hours = load.operating_hours.value if on and load.operating_hours.value is not None else 0.0
        hours.append(float(op_hours))
        raw_end = load.deadline_timesteps.value if on and load.deadline_timesteps.value is not None else 0
        end = int(float(raw_end))
        if end > 0:
            adjusted = end - offset
            if adjusted < 1:
                issues.append(
                    Issue(
                        "warning",
                        "deadline_passed",
                        f"{load.name}: deadline of {end} step(s) from now ends before the planned horizon starts",
                    )
                )
                adjusted = 1
            end = adjusted
        ends.append(end)
        single.append(bool(load.single_constant.value))
        if on and load.operating_hours.issue:
            issues.append(Issue("warning", "deferrable_input", f"{load.name}: {load.operating_hours.issue}"))
        if on and load.deadline_timesteps.issue:
            issues.append(Issue("warning", "deferrable_input", f"{load.name}: {load.deadline_timesteps.issue}"))

    payload: dict[str, Any] = {
        "load_cost_forecast": [round(s.import_price, PRICE_DECIMALS) for s in slots],
        "prod_price_forecast": [round(s.export_price, PRICE_DECIMALS) for s in slots],
        "prediction_horizon": len(slots),
        "pv_power_forecast": [round(v) for v in pv_values],
        "load_forecast_method": "mlforecaster",
        "var_model": settings.emhass.ml.var_model,
        "num_lags": derived.num_lags,
        "historic_days_to_retrieve": derived.historic_days_to_retrieve,
        "delta_forecast_daily": derived.delta_forecast_daily,
        "soc_init": _round(inputs.soc_init.value),
        "soc_final": _round(inputs.soc_final.value),
        "number_of_deferrable_loads": len(inputs.deferrables),
        "nominal_power_of_deferrable_loads": nominal,
        "operating_hours_of_each_deferrable_load": hours,
        "end_timesteps_of_each_deferrable_load": ends,
        "set_deferrable_load_single_constant": single,
    }
    extra = settings.emhass.extra_runtime_params
    if extra:
        payload.update(extra)

    explain = [
        {
            "i": i,
            "start": s.start.isoformat(),
            "origin": s.origin,
            "period": s.period,
            "spot": s.spot,
            "load_cost": payload["load_cost_forecast"][i],
            "prod_price": payload["prod_price_forecast"][i],
            "pv_w": payload["pv_power_forecast"][i],
        }
        for i, s in enumerate(slots)
    ]
    return BuildResult(payload, explain, anchor, len(slots), derived, issues)


def _round(value: float | bool | None) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    return round(float(value), 4)


def horizon_end(result: BuildResult) -> datetime | None:
    if not result.horizon:
        return None
    return result.anchor + timedelta(minutes=15 * result.horizon)


def is_finite_list(values: list[Any]) -> bool:
    return all(isinstance(v, (int, float)) and math.isfinite(v) for v in values)
