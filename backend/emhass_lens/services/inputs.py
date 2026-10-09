"""Collects everything an MPC run needs from the other services and Home Assistant."""

from datetime import datetime
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.issues import Issue
from emhass_lens.domain.mpc.inputs import DeferrableReading, MpcInputs, Reading, read_bool, read_number
from emhass_lens.settings.model import EntityInput

if TYPE_CHECKING:
    from emhass_lens.container import Container


class InputsService:
    def __init__(self, c: Container) -> None:
        self.c = c

    def entities(self) -> set[str]:
        s = self.c.settings.current.inputs
        ids = {s.soc_init.entity, s.soc_final.entity}
        for load in s.deferrable_loads:
            ids |= {
                load.enabled_entity,
                load.operating_hours_entity,
                load.deadline_timesteps_entity,
                load.single_constant_entity,
            }
        return {i for i in ids if i}

    def _reading(self, name: str, cfg: EntityInput, now: datetime) -> Reading:
        state = self.c.extras["ha"].state(cfg.entity)
        default = cfg.default if cfg.on_unavailable == "default" else None
        return read_number(name, cfg.entity, state, now, cfg.scale, default)

    def snapshot(self, now: datetime, *, legacy_compat: bool = False) -> MpcInputs:
        settings = self.c.settings.current
        ha = self.c.extras["ha"]
        forecasts = self.c.extras["forecasts"]
        prices_svc = self.c.extras["prices"]
        issues: list[Issue] = []
        if not ha.connected:
            issues.append(
                Issue("warning", "ha_disconnected", "Not connected to Home Assistant; entity values may be stale")
            )

        forecast = forecasts.current()
        if settings.forecast.source != "none" and forecast is None:
            issues.append(
                Issue("warning", "forecast_missing", f"The {settings.forecast.source} forecast isn't available")
            )
        prices = tuple(
            p for p in prices_svc.priced(slot_floor(now), forecast, legacy_compat=legacy_compat) if p.end > now
        )

        deferrables = []
        for load in settings.inputs.deferrable_loads:
            deferrables.append(
                DeferrableReading(
                    name=load.name,
                    enabled=read_bool("enabled", load.enabled_entity, ha.state(load.enabled_entity), now),
                    nominal_power_w=load.nominal_power_w,
                    operating_hours=read_number(
                        "operating_hours",
                        load.operating_hours_entity,
                        ha.state(load.operating_hours_entity),
                        now,
                        default=0.0,
                    ),
                    deadline_timesteps=read_number(
                        "deadline_timesteps",
                        load.deadline_timesteps_entity,
                        ha.state(load.deadline_timesteps_entity),
                        now,
                        default=0.0,
                    ),
                    single_constant=read_bool(
                        "single_constant", load.single_constant_entity, ha.state(load.single_constant_entity), now
                    ),
                )
            )
        return MpcInputs(
            taken_at=now,
            prices=prices,
            pv=self.c.extras["pv"].current(),
            soc_init=self._reading("soc_init", settings.inputs.soc_init, now),
            soc_final=self._reading("soc_final", settings.inputs.soc_final, now),
            deferrables=tuple(deferrables),
            forecast_source=settings.forecast.source,
            extend_days=settings.forecast.extend_days,
            issues=tuple(issues),
        )


def describe(inputs: MpcInputs) -> dict[str, Any]:
    """The inputs as shown in the UI and stored with each run."""

    def reading(r: Reading) -> dict[str, Any]:
        return {
            "name": r.name,
            "value": r.value,
            "source": r.source,
            "raw": r.raw,
            "age_s": r.age_s,
            "transform": r.transform,
            "issue": r.issue,
            "explain": r.explain(),
        }

    prices = inputs.prices
    actual = [p for p in prices if not p.is_forecast]
    pv_summary = None
    if inputs.pv is not None:
        starts = [p.start for p in prices]
        _, missing = inputs.pv.series(starts)
        pv_summary = {
            "field": inputs.pv.field_name,
            "sensors_used": list(inputs.pv.sensors_used),
            "sensors_missing": list(inputs.pv.sensors_missing),
            "slots_missing": len(missing),
            "first_missing": iso(missing[0]) if missing else None,
        }
    return {
        "taken_at": iso(inputs.taken_at),
        "prices": {
            "slots": len(prices),
            "actual": len(actual),
            "forecast": len(prices) - len(actual),
            "first": iso(prices[0].start) if prices else None,
            "end": iso(prices[-1].end) if prices else None,
            "forecast_source": inputs.forecast_source,
        },
        "pv": pv_summary,
        "soc_init": reading(inputs.soc_init),
        "soc_final": reading(inputs.soc_final),
        "deferrable_loads": [
            {
                "name": d.name,
                "nominal_power_w": d.nominal_power_w,
                "enabled": reading(d.enabled),
                "operating_hours": reading(d.operating_hours),
                "deadline_timesteps": reading(d.deadline_timesteps),
                "single_constant": reading(d.single_constant),
            }
            for d in inputs.deferrables
        ],
        "issues": [i.as_dict() for i in inputs.issues],
    }
