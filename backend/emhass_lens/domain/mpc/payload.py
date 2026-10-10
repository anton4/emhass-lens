"""Builds the naive-mpc-optim runtime parameters from timestamped inputs.

Everything stays timestamped until here; the lists EMHASS gets are positional, starting at the
anchor slot. The Explain table maps every position back to its slot, so a payload can be checked
by eye against prices and the PV forecast.
"""

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from emhass_lens.domain.areas import area_zone
from emhass_lens.domain.issues import Issue
from emhass_lens.domain.mpc.anchor import slot_offset
from emhass_lens.domain.mpc.inputs import MpcInputs
from emhass_lens.settings.model import Settings

PRICE_DECIMALS = 4
P10_VERSION = (0, 18, 4)  # EMHASS accepts pv_power_forecast_p10 next to pv_power_forecast


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


def local(dt: datetime, settings: Settings) -> str:
    """A slot time as people read it, e.g. "Fri 18:45" (local time of the bidding zone)."""
    return dt.astimezone(area_zone(settings.prices.nordpool.area)).strftime("%a %H:%M")


def build(
    inputs: MpcInputs,
    anchor: datetime,
    current_slot: datetime,
    settings: Settings,
    *,
    emhass_version: tuple[int, ...] | None = None,
    compat: bool = False,
) -> BuildResult:
    """`emhass_version` gates keys older EMHASS versions don't know. `compat` builds what the HACS
    integration sends (for the parity check): no P10 companion and no def_current_state."""
    issues: list[Issue] = []
    derived = derive(settings)
    mpc = settings.emhass.mpc

    slots = [p for p in inputs.prices if p.start >= anchor]
    if slots and slots[0].start != anchor:
        issues.append(
            Issue(
                "error",
                "anchor_not_covered",
                f"Prices start at {local(slots[0].start, settings)}, after the anchor slot {local(anchor, settings)}",
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
                f"Prices have a gap at {local(expected, settings)}; the horizon stops there",
            )
        )
    slots = contiguous[: mpc.max_horizon]
    starts = [s.start for s in slots]

    p10_values: list[float] | None = None
    if inputs.pv is not None:
        pv_values, pv_missing = inputs.pv.series(starts)
        if (
            not compat
            and settings.pv.send_p10
            and inputs.pv.has_p10
            and inputs.pv.field_name != "estimate10"
            and emhass_version is not None
            and emhass_version >= P10_VERSION
        ):
            p10_values = inputs.pv.p10_series(starts)
        if pv_missing:
            share = len(pv_missing) / max(1, len(starts))
            level = "warning" if share < 0.5 else "error"
            issues.append(
                Issue(
                    level,
                    "pv_coverage",
                    f"PV forecast missing for {len(pv_missing)} of {len(starts)} slots (sent as 0 W), "
                    f"first at {local(pv_missing[0], settings)}",
                    hint="Check the Solcast day sensors on the Inputs page.",
                )
            )
    else:
        pv_values = [0.0] * len(starts)

    offset = slot_offset(anchor, current_slot)
    nominal, hours, ends, single, running = [], [], [], [], []
    running_known = any(load.running is not None for load in inputs.deferrables)
    for load in inputs.deferrables:
        on = bool(load.enabled.value)
        nominal.append(load.nominal_power_w if on else 0)
        running.append(bool(on and load.running is not None and load.running.value))
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
    if p10_values is not None:
        payload["pv_power_forecast_p10"] = [round(v) for v in p10_values]
    if running_known and not compat:
        # a load that is on right now is planned as on, instead of getting a fresh start (EMHASS 0.18.2+)
        payload["def_current_state"] = running
    if mpc.costfun != "default" and not compat:
        # a runtime parameter since EMHASS 0.18 (optim_conf.costfun); the plan's cost_fun_* column shows what was used
        payload["costfun"] = mpc.costfun
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
            "pv_p10_w": payload["pv_power_forecast_p10"][i] if p10_values is not None else None,
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
