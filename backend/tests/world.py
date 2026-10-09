"""A fake outside world for tests: Nord Pool, eupowerprices.com, EMHASS, Supervisor and HA REST."""

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from tests.fixtures.loader import load_json, nordpool

TZ = ZoneInfo("Europe/Tallinn")
EMHASS_URL = "http://emhass.test:5000"
HA_URL = "http://ha.test"


def solcast_day(day_start_local: datetime, kw: float = 3.0) -> dict[str, Any]:
    return {
        "detailedForecast": [
            {
                "period_start": (day_start_local + timedelta(minutes=30 * i)).isoformat(),
                "pv_estimate": round(kw * max(0.0, 1 - abs(i - 26) / 12), 4),
                "pv_estimate10": 0.1,
                "pv_estimate90": kw,
            }
            for i in range(48)
        ]
    }


@dataclass
class World:
    nordpool_days: dict[str, Any] = field(
        default_factory=lambda: {
            "2026-10-08": nordpool("2026-10-08"),
            "2026-10-09": nordpool("2026-10-09"),
            "2026-10-10": nordpool("2026-10-10"),
        }
    )
    nordpool_calls: list[str] = field(default_factory=list)
    ee_forecast: dict[str, Any] | None = None
    ee_status: int = 200
    emhass_config: dict[str, Any] = field(
        default_factory=lambda: {
            **load_json("emhass", "emhass_get_config.json"),
            "time_zone": "Europe/Tallinn",
        }
    )
    emhass_version: str = "0.18.3"
    emhass_up: bool = True
    emhass_last_run: dict[str, Any] = field(default_factory=lambda: {"status": "no-run", "timestamp": None})
    emhass_plan: dict[str, Any] = field(default_factory=lambda: {"status": "no-run", "plan": None})
    emhass_actions: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    action_status: str = "ok"
    ha_states: dict[str, dict[str, Any]] = field(default_factory=dict)
    ha_services: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    ha_events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    clock_now: Any = None  # callable returning "now" for EMHASS timestamps
    supervisor_lists_addons: bool = False  # the default App role may not list Apps

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        host, path = url.host, url.path
        if host == "dataportal-api.nordpoolgroup.com":
            day = url.params.get("date")
            self.nordpool_calls.append(day)
            body = self.nordpool_days.get(day)
            return httpx.Response(200, json=body) if body else httpx.Response(204)
        if host == "api.eupowerprices.com":
            if self.ee_status != 200:
                return httpx.Response(self.ee_status, json={"detail": "nope"})
            return httpx.Response(200, json=self.ee_forecast or {"series": []})
        if host in ("emhass.test", "5b918bf2-emhass"):
            return self._emhass(request, path)
        if host == "supervisor":
            if path == "/addons":
                if not self.supervisor_lists_addons:
                    return httpx.Response(403, json={"result": "error", "message": "Access not allowed for this App"})
                return httpx.Response(200, json={"result": "ok", "data": {"addons": [{"slug": "5b918bf2_emhass"}]}})
            if path == "/addons/5b918bf2_emhass/info":
                return httpx.Response(
                    200,
                    json={
                        "result": "ok",
                        "data": {"slug": "5b918bf2_emhass", "state": "started", "network": {"5000/tcp": 5001}},
                    },
                )
            return httpx.Response(404, json={"result": "error", "message": "not found"})
        if host == "ha.test":
            return self._ha(request, path)
        return httpx.Response(599, text=f"unexpected request {request.method} {url}")

    def _emhass(self, request: httpx.Request, path: str) -> httpx.Response:
        if not self.emhass_up:
            raise httpx.ConnectError("connection refused", request=request)
        if path == "/healthz":
            return httpx.Response(
                200,
                json={"status": "ok", "boot_ts": "2026-10-09T00:00:00Z", "versions": {"emhass": self.emhass_version}},
            )
        if path == "/get-config":
            return httpx.Response(200, json=self.emhass_config)
        if path == "/api/v1/last-run":
            return httpx.Response(200, json=self.emhass_last_run)
        if path == "/api/v1/plan":
            return httpx.Response(200, json=self.emhass_plan)
        if path.startswith("/action/"):
            name = path.removeprefix("/action/")
            payload = json.loads(request.content or b"{}")
            self.emhass_actions.append((name, payload))
            if name == "naive-mpc-optim":
                now = self.clock_now() if self.clock_now else datetime.now(UTC)
                stamp = now.astimezone(UTC).isoformat()
                if self.action_status == "error":
                    self.emhass_last_run = {"status": "error", "timestamp": stamp, "error_message": "solver failed"}
                    return httpx.Response(400, text="ERROR - solver failed\n")
                self.emhass_last_run = {"status": self.action_status, "timestamp": stamp}
                if self.action_status == "ok":
                    self.emhass_plan = make_plan(now, payload)
            return httpx.Response(200, text=f"EMHASS >> Action {name} executed... \n")
        return httpx.Response(404)

    def _ha(self, request: httpx.Request, path: str) -> httpx.Response:
        if path.startswith("/api/states/"):
            state = self.ha_states.get(path.removeprefix("/api/states/"))
            if state is None:
                return httpx.Response(404, json={"message": "Entity not found."})
            return httpx.Response(200, json=state)
        if path == "/api/states":
            return httpx.Response(200, json=list(self.ha_states.values()))
        if path.startswith("/api/services/"):
            body = json.loads(request.content or b"{}")
            self.ha_services.append((path.removeprefix("/api/services/"), body))
            domain_service = path.removeprefix("/api/services/")
            entity = body.get("entity_id")
            if domain_service == "number/set_value" and entity:
                self.set_state(entity, float(body["value"]))
            if domain_service == "input_select/select_option" and entity:
                self.set_state(entity, body["option"])
            if domain_service in ("switch/turn_off", "switch/turn_on"):
                entity = body.get("entity_id")
                if entity in self.ha_states:
                    self.ha_states[entity]["state"] = "off" if domain_service.endswith("off") else "on"
            return httpx.Response(200, json=[])
        if path.startswith("/api/events/"):
            self.ha_events.append((path.removeprefix("/api/events/"), json.loads(request.content or b"{}")))
            return httpx.Response(200, json={"message": "Event fired."})
        return httpx.Response(404)

    def set_state(
        self, entity_id: str, state: Any, attributes: dict[str, Any] | None = None, updated: datetime | None = None
    ) -> dict[str, Any]:
        value = {
            "entity_id": entity_id,
            "state": str(state),
            "attributes": attributes or {},
            "last_updated": (updated or datetime(2026, 10, 9, 11, 0, tzinfo=UTC)).isoformat(),
        }
        self.ha_states[entity_id] = value
        return value

    def standard_entities(self, day_start_local: datetime) -> None:
        self.set_state("sensor.ev6_battery_soc", 62, {"unit_of_measurement": "%"})
        self.set_state("input_number.emhass_target_soc", 80)
        self.set_state("input_boolean.ev_charging_enabled", "off")
        self.set_state("sensor.ev_operating_hours", 0)
        self.set_state("sensor.ev_charging_timesteps", 0)
        self.set_state("input_boolean.ev_force_continuous_charging", "off")
        self.set_state("select.solcast_pv_forecast_use_forecast_field", "estimate")
        for i, suffix in enumerate(("today", "tomorrow", "day_3", "day_4", "day_5", "day_6", "day_7")):
            self.set_state(
                f"sensor.solcast_pv_forecast_forecast_{suffix}", 10, solcast_day(day_start_local + timedelta(days=i))
            )

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


def make_plan(now: datetime, payload: dict[str, Any]) -> dict[str, Any]:
    """A plan shaped like EMHASS's /api/v1/plan, anchored where EMHASS would anchor it ('nearest')."""
    ts = now.astimezone(UTC).timestamp()
    start = datetime.fromtimestamp(round(ts / 900) * 900, UTC)
    rows = []
    soc = payload.get("soc_init") or 0.5
    for i, cost in enumerate(payload.get("load_cost_forecast") or []):
        p_batt = -3000.0 if cost < 0.15 else 2000.0
        soc = min(1.0, max(0.05, soc - p_batt / 74000 / 4))
        rows.append(
            {
                "timestamp": (start + timedelta(minutes=15 * i)).isoformat().replace("+00:00", "Z"),
                "P_PV": float(payload["pv_power_forecast"][i]),
                "P_Load": 1500.0,
                "P_batt": p_batt,
                "P_grid": 1500.0 - payload["pv_power_forecast"][i] - p_batt,
                "SOC_opt": round(soc, 4),
                "P_deferrable0": 0.0,
                "P_PV_curtailment": 0.0,
                "unit_load_cost": cost,
                "unit_prod_price": payload["prod_price_forecast"][i],
            }
        )
    return {"status": "ok", "generated_at": now.astimezone(UTC).isoformat(), "emhass_schema_version": "1", "plan": rows}
