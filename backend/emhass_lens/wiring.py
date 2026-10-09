"""Phase 1+ services: created once at startup, registered as jobs, re-wired on settings changes."""

import asyncio
import logging
from datetime import timedelta
from typing import Any

from emhass_lens.api.schemas import ComponentStatus
from emhass_lens.clients.emhass import EmhassClient
from emhass_lens.clients.ha import HaClient
from emhass_lens.clients.http import make_client
from emhass_lens.clients.supervisor import SupervisorClient
from emhass_lens.container import Container
from emhass_lens.scheduler.core import Job, JobContext
from emhass_lens.scheduler.triggers import Dynamic, Manual, Periodic, QuarterHour
from emhass_lens.services import health_rules
from emhass_lens.services.emhass import EmhassService
from emhass_lens.services.forecasts import ForecastService
from emhass_lens.services.inputs import InputsService
from emhass_lens.services.inverter import InverterService
from emhass_lens.services.ml import MlService
from emhass_lens.services.mpc import MpcService
from emhass_lens.services.outputs import OutputService
from emhass_lens.services.parity import ParityService
from emhass_lens.services.prices import PriceService
from emhass_lens.services.problems import ProblemService
from emhass_lens.services.publish import PublishService
from emhass_lens.services.pv import PvService
from emhass_lens.settings.model import Settings

log = logging.getLogger("emhass_lens")


def build(c: Container) -> None:
    x = c.extras
    transport = x.get("http_transport")
    x["http_nordpool"] = make_client("nordpool", timeout=20, transport=transport)
    x["http_forecast"] = make_client("eupowerprices", timeout=20, transport=transport)
    x["ha"] = HaClient(c.boot.ha_url, c.boot.ha_token, c.clock, c.bus, transport=transport)
    x["supervisor"] = SupervisorClient(c.boot.supervisor_url, c.boot.supervisor_token, transport=transport)
    x["emhass_client"] = EmhassClient(transport=transport)
    x["prices"] = PriceService(c, x["http_nordpool"])
    x["forecasts"] = ForecastService(c, x["http_forecast"])
    x["pv"] = PvService(c)
    x["inputs"] = InputsService(c)
    x["emhass"] = EmhassService(c, x["emhass_client"], x["supervisor"])
    x["mpc"] = MpcService(c)
    x["parity"] = ParityService(c)
    x["problems"] = ProblemService(c)
    x["publish"] = PublishService(c)
    x["ml"] = MlService(c)
    x["outputs"] = OutputService(c)
    x["inverter"] = InverterService(c)
    x["prices"].load()
    x["problems"].load()
    x["status_providers"] = {
        "home_assistant": lambda: _ha_status(c),
        "emhass": lambda: _emhass_status(c),
        "prices": lambda: _problem_status(c, "prices", "Prices complete"),
        "forecast": lambda: _forecast_status(c),
        "pv": lambda: _pv_status(c),
        "mqtt": lambda: _mqtt_status(c),
    }


def watched_entities(c: Container) -> set[str]:
    x = c.extras
    settings = c.settings.current
    ids = x["inputs"].entities() | x["pv"].entities() | x["inverter"].entities()
    if settings.forecast.source == "fi_ha_entity":
        ids.add(settings.forecast.fi.entity)
    if settings.parity.legacy_auto_mpc_switch:
        ids.add(settings.parity.legacy_auto_mpc_switch)
    return ids


def register_jobs(c: Container) -> None:
    x = c.extras
    s = c.scheduler
    settings = c.settings.current

    s.add(
        Job(
            id="nordpool.poll",
            title="Nord Pool prices",
            description="Fetches day-ahead prices per delivery day when they are due (see Inputs for why and when).",
            trigger=Dynamic(x["prices"].next_poll, "When prices are due (13:45 onwards for tomorrow)"),
            func=x["prices"].poll,
            grace=timedelta(minutes=30),
        )
    )
    s.add(
        Job(
            id="forecast.ee.poll",
            title="eupowerprices.com forecast",
            description="Fetches the EE price forecast every N hours (Settings → Price forecast); backs off on errors.",
            trigger=Dynamic(x["forecasts"].next_ee_poll, "Every N hours while selected"),
            func=x["forecasts"].poll_ee,
            grace=timedelta(hours=2),
        )
    )
    s.add(
        Job(
            id="emhass.mpc",
            title="EMHASS MPC",
            description="Builds the naive-mpc-optim payload, checks it and (in live mode) sends it to EMHASS.",
            trigger=QuarterHour(settings.emhass.mpc.slot_offset_s),
            func=x["mpc"].run,
            grace=timedelta(minutes=2),
            mode=lambda: x["mpc"].mode,
        )
    )
    s.add(
        Job(
            id="emhass.health",
            title="EMHASS health",
            description="Checks /healthz every minute; re-reads the configuration when EMHASS restarts.",
            trigger=Periodic(60, 20),
            func=x["emhass"].poll_health,
            record=False,
            grace=timedelta(minutes=5),
        )
    )
    s.add(
        Job(
            id="emhass.config_check",
            title="EMHASS configuration check",
            description="Reads EMHASS's effective configuration and checks what EMHASS Lens relies on.",
            trigger=Periodic(3600, 300),
            func=x["emhass"].check_config,
            grace=timedelta(hours=1),
        )
    )
    s.add(
        Job(
            id="emhass.plan_watch",
            title="EMHASS plan watch",
            description="Stores each new EMHASS plan (also plans made by someone else, e.g. the HACS integration).",
            trigger=Periodic(300, 40),
            func=_plan_watch(c),
            grace=timedelta(minutes=5),
        )
    )
    s.add(
        Job(
            id="parity.check",
            title="Parity with the HACS integration",
            description="Compares prices, PV and the MPC payload with the HACS integration's entities.",
            trigger=QuarterHour(300),
            func=x["parity"].run,
            grace=timedelta(minutes=5),
        )
    )
    s.add(
        Job(
            id="emhass.publish",
            title="EMHASS publish",
            description="Live mode: publish-data at the start of each slot, then the plan-published event and "
            "MQTT state.",
            trigger=QuarterHour(settings.emhass.publish.slot_offset_s),
            func=x["publish"].run,
            record=x["publish"].active,
            grace=timedelta(minutes=5),
        )
    )
    s.add(
        Job(
            id="ml.fit",
            title="ML model fit",
            description="Fits EMHASS's load forecast model (forecast-model-fit) with the lags MPC uses.",
            trigger=Manual(),
            func=x["ml"].fit,
        )
    )
    s.add(
        Job(
            id="ml.tune",
            title="ML model tune",
            description="Tunes the load forecast model (forecast-model-tune).",
            trigger=Manual(),
            func=x["ml"].tune,
        )
    )
    s.add(
        Job(
            id="ml.predict",
            title="ML model predict",
            description="Publishes sensor.p_load_forecast_custom_model (forecast-model-predict).",
            trigger=Manual(),
            func=x["ml"].predict,
        )
    )
    s.add(
        Job(
            id="outputs.refresh",
            title="MQTT entities",
            description="Publishes the current prices, problem state and Auto MPC switch state over MQTT.",
            trigger=Periodic(60, 1),
            func=_refresh_outputs(c),
            record=False,
            grace=timedelta(minutes=5),
        )
    )
    s.add(
        Job(
            id="inverter.decide",
            title="Inverter decision",
            description="Decides the Sofar passive-mode settings for the slot from the plan (dry run: records only).",
            trigger=QuarterHour(settings.inverter.decide_offset_s),
            func=x["inverter"].decide_job,
            record=x["inverter"].should_record_decide,
            grace=timedelta(minutes=5),
        )
    )
    s.add(
        Job(
            id="inverter.compare",
            title="Inverter comparison",
            description="Dry run: compares the decision with what the HA automation set on the inverter.",
            trigger=QuarterHour(settings.inverter.compare_offset_s),
            func=x["inverter"].compare_job,
            record=x["inverter"].compare_job_active,
            grace=timedelta(minutes=5),
        )
    )
    s.add(
        Job(
            id="health.evaluate",
            title="Health",
            description="Evaluates the health rules and updates the problem list.",
            trigger=Periodic(60, 30),
            func=_health(c),
            record=False,
            grace=timedelta(minutes=5),
        )
    )


def _plan_watch(c: Container):
    async def run(ctx: JobContext) -> None:
        await c.extras["emhass"].watch_plan(ctx, driver="legacy" if c.extras["mpc"].legacy_driving() else "external")

    return run


def _refresh_outputs(c: Container):
    async def run(ctx: JobContext) -> None:
        await c.extras["outputs"].refresh()

    return run


def _health(c: Container):
    async def run(ctx: JobContext) -> None:
        await c.extras["problems"].sync(health_rules.evaluate(c, c.clock.now()))

    return run


def subscribe(c: Container) -> None:
    x = c.extras
    ha: HaClient = x["ha"]

    def rewatch(*_: Any) -> None:
        loading = ha.set_watched(watched_entities(c))
        if loading is not None:
            _spawn(c, _evaluate_after(c, loading))

    def on_prices(old: Settings, new: Settings, paths: list[str]) -> None:
        if old.prices.nordpool.area != new.prices.nordpool.area:
            x["prices"].load()
        c.scheduler.retime("nordpool.poll")

    def on_forecast(old: Settings, new: Settings, paths: list[str]) -> None:
        c.scheduler.retime("forecast.ee.poll")
        rewatch()

    def on_mpc_time(old: Settings, new: Settings, paths: list[str]) -> None:
        c.scheduler.retime("emhass.mpc", QuarterHour(new.emhass.mpc.slot_offset_s))

    def on_emhass_url(old: Settings, new: Settings, paths: list[str]) -> None:
        _spawn(c, _resolve_and_check(c))

    def on_checks(old: Settings, new: Settings, paths: list[str]) -> None:
        c.scheduler.run_now("emhass.config_check")

    def on_publish_time(old: Settings, new: Settings, paths: list[str]) -> None:
        c.scheduler.retime("emhass.publish", QuarterHour(new.emhass.publish.slot_offset_s))

    async def on_outputs(old: Settings, new: Settings, paths: list[str]) -> None:
        if old.outputs.mqtt_enabled and not new.outputs.mqtt_enabled:
            await x["outputs"].stop(clear=True)  # remove the device's entities from Home Assistant
            return
        if (
            old.outputs.mqtt_enabled != new.outputs.mqtt_enabled
            or old.outputs.broker != new.outputs.broker
            or old.outputs.topic_prefix != new.outputs.topic_prefix
            or old.outputs.discovery_prefix != new.outputs.discovery_prefix
        ):
            await x["outputs"].restart()

    async def on_state_change(old: Settings, new: Settings, paths: list[str]) -> None:
        await x["outputs"].refresh()

    c.settings.subscribe("prices.nordpool", on_prices)
    c.settings.subscribe("forecast", on_forecast)
    c.settings.subscribe(("inputs", "pv", "parity", "inverter"), rewatch)

    def on_inverter_times(old: Settings, new: Settings, paths: list[str]) -> None:
        c.scheduler.retime("inverter.decide", QuarterHour(new.inverter.decide_offset_s))
        c.scheduler.retime("inverter.compare", QuarterHour(new.inverter.compare_offset_s))

    c.settings.subscribe(("inverter.decide_offset_s", "inverter.compare_offset_s"), on_inverter_times)
    c.settings.subscribe("emhass.mpc.slot_offset_s", on_mpc_time)
    c.settings.subscribe("emhass.base_url", on_emhass_url)
    c.settings.subscribe(("emhass.mode", "emhass.publish", "emhass.ml", "inputs.deferrable_loads"), on_checks)
    c.settings.subscribe("emhass.publish.slot_offset_s", on_publish_time)
    c.settings.subscribe("outputs", on_outputs)
    c.settings.subscribe(("emhass.mpc.auto", "prices.tariff"), on_state_change)

    ha.on_state(lambda entity_id: entity_id == c.settings.current.forecast.fi.entity, x["forecasts"].on_fi_state)
    rewatch()


async def _evaluate_after(c: Container, loading: asyncio.Task[None]) -> None:
    """Re-check health as soon as newly watched entities are loaded, not a minute later."""
    await loading
    c.scheduler.run_now("health.evaluate")


async def _resolve_and_check(c: Container) -> None:
    await c.extras["emhass"].resolve()
    c.scheduler.run_now("emhass.health")
    c.scheduler.run_now("emhass.config_check")


def _spawn(c: Container, coro: Any) -> None:
    tasks: set[asyncio.Task[Any]] = c.extras.setdefault("background_tasks", set())
    task = asyncio.create_task(coro)
    tasks.add(task)
    task.add_done_callback(tasks.discard)


async def start(c: Container) -> None:
    c.extras["ha"].start()
    c.extras["outputs"].start()
    _spawn(c, _resolve_and_check(c))


async def stop(c: Container) -> None:
    x = c.extras
    await x["outputs"].stop()
    await x["ha"].stop()
    for key in ("http_nordpool", "http_forecast"):
        await x[key].aclose()
    await x["supervisor"].close()
    await x["emhass_client"].close()


# --- component status for the header ------------------------------------------------------------------


def _ha_status(c: Container) -> ComponentStatus:
    ha = c.extras["ha"]
    if not ha.configured:
        return ComponentStatus(status="error", detail=ha.last_error)
    if ha.connected:
        return ComponentStatus(status="ok", detail=f"Home Assistant {ha.ha_version}")
    return ComponentStatus(status="error", detail=ha.last_error or "connecting…")


def _emhass_status(c: Container) -> ComponentStatus:
    e = c.extras["emhass"]
    if e.reachable is None:
        return ComponentStatus(status="unknown", detail="checking…")
    if not e.reachable:
        return ComponentStatus(status="error", detail=e.last_error)
    worst = e.status()["checks_status"]
    level = {"ok": "ok", "warning": "warning", "error": "error"}.get(worst, "ok")
    return ComponentStatus(status=level, detail=f"EMHASS {e.version} at {e.url}")


def _problem_status(c: Container, prefix: str, ok_text: str) -> ComponentStatus:
    active = [p for p in c.extras["problems"].problems.values() if p.key.startswith(prefix + ".")]
    if not active:
        return ComponentStatus(status="ok", detail=ok_text)
    worst = "error" if any(p.severity == "error" for p in active) else "warning"
    return ComponentStatus(status=worst, detail="; ".join(p.title for p in active))


def _forecast_status(c: Container) -> ComponentStatus:
    if c.settings.current.forecast.source == "none":
        return ComponentStatus(status="disabled", detail="No price forecast selected")
    return _problem_status(c, "forecast", "Forecast available")


def _mqtt_status(c: Container) -> ComponentStatus:
    out = c.extras["outputs"]
    if not out.enabled():
        return ComponentStatus(status="disabled", detail="MQTT entities are off")
    if out.connected:
        return ComponentStatus(status="ok", detail=f"MQTT broker {out.broker}")
    return ComponentStatus(status="warning", detail=out.last_error or "connecting…")


def _pv_status(c: Container) -> ComponentStatus:
    if c.settings.current.pv.source == "none":
        return ComponentStatus(status="disabled", detail="No PV forecast")
    return _problem_status(c, "pv", "Solcast forecast available")
