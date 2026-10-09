"""PV forecast from the Solcast day sensors in Home Assistant."""

from typing import TYPE_CHECKING, Any

from emhass_lens.domain.pv_solcast import PvForecast, day_sensors, parse

if TYPE_CHECKING:
    from emhass_lens.container import Container


class PvService:
    def __init__(self, c: Container) -> None:
        self.c = c

    def entities(self) -> set[str]:
        pv = self.c.settings.current.pv
        if pv.source == "none":
            return set()
        ids = set(day_sensors(pv.entity_prefix, pv.days))
        if pv.field == "from_select" and pv.field_select_entity:
            ids.add(pv.field_select_entity)
        return ids

    def field_name(self) -> str:
        pv = self.c.settings.current.pv
        if pv.field != "from_select":
            return pv.field
        state = self.c.extras["ha"].state(pv.field_select_entity) if pv.field_select_entity else None
        value = (state or {}).get("state")
        return value if value in ("estimate", "estimate10", "estimate90") else "estimate"

    def current(self) -> PvForecast | None:
        pv = self.c.settings.current.pv
        if pv.source == "none":
            return None
        ha = self.c.extras["ha"]
        states = {sid: ha.state(sid) for sid in day_sensors(pv.entity_prefix, pv.days)}
        return parse(states, self.field_name(), pv.scale)

    def status(self) -> dict[str, Any]:
        forecast = self.current()
        if forecast is None:
            return {"source": "none"}
        starts = sorted(forecast.watts)
        return {
            "source": "solcast",
            "field": forecast.field_name,
            "sensors_used": list(forecast.sensors_used),
            "sensors_missing": list(forecast.sensors_missing),
            "slots": len(starts),
            "start": starts[0].isoformat() if starts else None,
            "end": starts[-1].isoformat() if starts else None,
        }
