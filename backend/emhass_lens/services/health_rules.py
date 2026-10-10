"""Health rules: looks at every service once a minute and lists what needs attention."""

from datetime import datetime, time, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.services.prices import area_tz, utc_day_start
from emhass_lens.services.problems import Problem

if TYPE_CHECKING:
    from emhass_lens.container import Container


def _hhmm(value: str) -> time:
    h, m = value.split(":")
    return time(int(h), int(m))


def evaluate(c: Container, now: datetime) -> list[Problem]:
    settings = c.settings.current
    x = c.extras
    out: list[Problem] = []

    if c.settings.load_errors:
        out.append(
            Problem(
                "settings.invalid",
                "error",
                "Stored settings are invalid",
                "; ".join(f"{e['loc']}: {e['msg']}" for e in c.settings.load_errors),
                "Fix them under Settings; jobs stay paused until then.",
                "#/settings",
            )
        )

    # Home Assistant connection
    ha = x["ha"]
    if not ha.configured:
        out.append(
            Problem(
                "ha.no_token",
                "error",
                "No Home Assistant access",
                ha.last_error,
                "Standalone: set HA_URL and HA_TOKEN.",
                "#/health",
            )
        )
    elif not ha.connected and ha.disconnected_since and now - ha.disconnected_since > timedelta(seconds=60):
        out.append(
            Problem("ha.disconnected", "error", "Not connected to Home Assistant", ha.last_error, link="#/health")
        )

    # Prices
    prices = x["prices"]
    tz = area_tz(settings)
    local_today = now.astimezone(tz).date()
    today_start = utc_day_start(local_today, tz)
    tomorrow_start = utc_day_start(local_today + timedelta(days=1), tz)
    day_after = utc_day_start(local_today + timedelta(days=2), tz)
    today_slots = prices.entries(today_start, tomorrow_start)
    expected_today = int((tomorrow_start - today_start).total_seconds() // 900)
    if len(today_slots) < expected_today:
        missing_now = not any(e.start <= now < e.end for e in today_slots)
        out.append(
            Problem(
                "prices.today_incomplete",
                "error" if missing_now else "warning",
                "Today's prices are incomplete",
                f"{len(today_slots)} of {expected_today} slots",
                "See the Nord Pool fetches on the Inputs page.",
                "#/inputs",
            )
        )
    tomorrow_slots = prices.entries(tomorrow_start, day_after)
    expected_tomorrow = int((day_after - tomorrow_start).total_seconds() // 900)
    local_now = now.astimezone(tz).time()
    if len(tomorrow_slots) < expected_tomorrow:
        if local_now >= _hhmm(settings.health.tomorrow_error_after):
            out.append(
                Problem(
                    "prices.tomorrow_missing",
                    "error",
                    "Tomorrow's prices are missing",
                    f"{len(tomorrow_slots)} of {expected_tomorrow} slots",
                    link="#/inputs",
                )
            )
        elif local_now >= _hhmm(settings.health.tomorrow_warn_after):
            out.append(
                Problem(
                    "prices.tomorrow_missing",
                    "warning",
                    "Tomorrow's prices haven't arrived yet",
                    f"{len(tomorrow_slots)} of {expected_tomorrow} slots",
                    link="#/inputs",
                )
            )
    failing = [st for st in prices.states.values() if st.consecutive_errors >= 3]
    if failing:
        out.append(
            Problem(
                "prices.fetch_failing",
                "warning",
                "Nord Pool fetches are failing",
                ", ".join(f"{st.day}: {st.consecutive_errors} failures" for st in failing),
                link="#/runs",
            )
        )

    # Forecast
    if settings.forecast.source != "none":
        fstatus = x["forecasts"].status_by_provider.get(settings.forecast.source)
        current = x["forecasts"].current()
        if current is None:
            out.append(
                Problem(
                    "forecast.missing",
                    "warning",
                    "The price forecast isn't available",
                    fstatus.error if fstatus else None,
                    link="#/inputs",
                )
            )
        elif fstatus and fstatus.consecutive_errors >= 3:
            out.append(
                Problem(
                    "forecast.failing", "warning", "Price forecast updates are failing", fstatus.error, link="#/runs"
                )
            )

    # PV
    pv = x["pv"].current()
    if pv is not None and ha.connected:
        if not pv.sensors_used:
            out.append(
                Problem(
                    "pv.missing",
                    "warning",
                    "No Solcast PV forecast found",
                    f"Looked for {settings.pv.entity_prefix}today …",
                    "Check Settings → PV forecast.",
                    "#/inputs",
                )
            )
        elif any(s.endswith(("today", "tomorrow")) for s in pv.sensors_missing):
            out.append(
                Problem(
                    "pv.partial",
                    "warning",
                    "Part of the Solcast PV forecast is missing",
                    ", ".join(pv.sensors_missing),
                    link="#/inputs",
                )
            )

    # MPC inputs
    if ha.connected:
        inputs = x["inputs"].snapshot(now)
        for reading, label in ((inputs.soc_init, "Battery SOC now"), (inputs.soc_final, "Target SOC")):
            if reading.value is None:
                out.append(
                    Problem(
                        f"inputs.{reading.name}",
                        "error" if settings.emhass.mode != "off" else "warning",
                        f"{label} can't be read",
                        reading.issue,
                        "Check Settings → Inputs.",
                        "#/inputs",
                    )
                )

    # EMHASS
    emhass = x["emhass"]
    mode = x["mpc"].mode
    if emhass.reachable is False and emhass.unreachable_since and now - emhass.unreachable_since > timedelta(minutes=2):
        out.append(
            Problem(
                "emhass.unreachable",
                "error" if mode == "live" else "warning",
                "EMHASS is not reachable",
                emhass.last_error,
                "Check Settings → EMHASS → address.",
                "#/health",
            )
        )
    for check in emhass.checks:
        if check.status in ("error", "warning") and (check.status == "error" or mode != "off"):
            out.append(
                Problem(
                    f"emhass.check.{check.key}",
                    check.status,
                    f"EMHASS: {check.title}",
                    f"expected {check.expected}, found {check.actual}",
                    check.explanation,
                    "#/health",
                )
            )

    # Driving EMHASS
    mpc = x["mpc"]
    if mpc.driver() == "both":
        out.append(
            Problem(
                "mpc.double_driver",
                "error",
                "Two planners are driving EMHASS",
                "The HACS integration's Auto MPC and EMHASS Lens live mode are both on",
                "Use 'Take over' or 'Hand back' on the Health page.",
                "#/health",
            )
        )
    if mode == "live" and settings.emhass.mpc.auto:
        last = mpc.last_success_at
        stale_after = timedelta(minutes=15 * settings.health.plan_max_age_slots)
        # the grace counts from the moment the App became the driver, not from the process start
        since = max(c.started_at, mpc.live_since or c.started_at)
        if (last is None and now - since > stale_after) or (last is not None and now - last > stale_after):
            out.append(
                Problem(
                    "mpc.stale",
                    "error",
                    "No successful MPC run recently",
                    f"last success {last.isoformat()}"
                    if last
                    else f"no live run has succeeded since EMHASS Lens took over at {since.astimezone(tz):%H:%M}",
                    link="#/runs",
                )
            )

    # Market session hold
    external = x.get("external")
    if external is not None and external.enabled() and ha.connected:
        entity = settings.external_control.entity
        if entity and ha.state(entity) is None:
            out.append(
                Problem(
                    "external.entity_missing",
                    "warning",
                    "The market session entity isn't found",
                    f"{entity} has no state in Home Assistant, so sessions can't hold the inverter",
                    "Check Settings → Market session hold.",
                    "#/settings?section=external_control",
                )
            )

    # Qilowatt market control
    market = x.get("market")
    if market is not None and market.active():
        me = settings.market.entities
        if market.mode == "live" and x["inverter"].mode != "live":
            out.append(
                Problem(
                    "market.live_without_inverter_live",
                    "warning",
                    "Market control is live but inverter control isn't",
                    "After a session EMHASS Lens can't hand the inverter back to the plan itself",
                    "Set Settings → Inverter control to Live, or market control to Shadow.",
                    "#/market",
                )
            )
        if ha.connected:
            missing = [
                eid
                for eid in (me.source_sensor, me.mode_sensor, me.powerlimit_sensor, me.soc_sensor)
                if eid and ha.state(eid) is None
            ]
            if missing:
                out.append(
                    Problem(
                        "market.entities_missing",
                        "warning",
                        "Market entities aren't found",
                        ", ".join(missing),
                        "Check Settings → Qilowatt market control.",
                        "#/settings?section=market",
                    )
                )
            if market.mode == "live" and me.ha_automation and (ha.state(me.ha_automation) or {}).get("state") == "on":
                out.append(
                    Problem(
                        "market.automation_still_on",
                        "error",
                        "The Home Assistant market automation is still on",
                        f"{me.ha_automation} is on while EMHASS Lens runs the sessions",
                        "Turn the automation off, or set market control to Shadow.",
                        "#/market",
                    )
                )
    if market is not None and c.boot.safe_mode and market.session is not None:
        out.append(
            Problem(
                "market.session_in_safe_mode",
                "error",
                "A market session is open but safe mode is on",
                "Nobody ends the session; the inverter may stay in force charge or discharge",
                "Turn safe mode off, or end the session in Home Assistant.",
                "#/market",
            )
        )

    # ML model and MQTT
    mismatch = x["ml"].lags_mismatch()
    if mismatch:
        out.append(
            Problem(
                "ml.lags_changed",
                "warning",
                "The ML load model should be refitted",
                mismatch,
                "Run 'ML model fit' on the Health page.",
                "#/health",
            )
        )
    outputs = x["outputs"]
    if outputs.enabled() and not outputs.connected:
        out.append(
            Problem(
                "mqtt.disconnected",
                "warning",
                "MQTT entities aren't being updated",
                outputs.last_error,
                "Check the Mosquitto broker App or Settings → Home Assistant outputs.",
                "#/health",
            )
        )

    # Scheduler
    for job in c.scheduler.jobs.values():
        if job.last_outcome == "missed":
            out.append(
                Problem(
                    f"jobs.missed.{job.id}",
                    "warning",
                    f"Job '{job.title}' missed its time",
                    "The host may have been suspended or overloaded.",
                    link="#/runs",
                )
            )
    # Cost function: did EMHASS honour the one asked for?
    costfun = x.get("costfun")
    if costfun is not None and costfun.ignored:
        out.append(
            Problem(
                "emhass.costfun_ignored",
                "warning",
                "EMHASS ignored the cost function",
                costfun.ignored,
                "Update EMHASS (0.18.5 is recommended), or set the cost function in EMHASS itself and choose "
                "'EMHASS's own setting' here.",
                "#/settings?section=emhass",
            )
        )

    # Measurements (plan history and accuracy)
    measurements = x.get("measurements")
    if measurements is not None and ha.connected:
        missing = sorted(cfg.entity for cfg in measurements.configured().values() if ha.state(cfg.entity) is None)
        if missing:
            out.append(
                Problem(
                    "measurements.entity_missing",
                    "warning",
                    "A measurement entity isn't found",
                    ", ".join(missing) + " has no state in Home Assistant, so the Plan page can't show what happened",
                    "Check Settings → Measurements.",
                    "#/settings?section=measurements",
                )
            )
        last = measurements.last_sample_at
        recent = last is not None and now - last <= timedelta(hours=1)
        if measurements.enabled() and measurements.last_error and not recent:
            out.append(
                Problem(
                    "measurements.unavailable",
                    "warning",
                    "Measurements can't be read from Home Assistant",
                    measurements.last_error,
                    "The Plan page can't show what happened until this works. See the Measurement history runs.",
                    "#/runs?job=measure.backfill",
                )
            )
        elif measurements.enabled() and now - (last or c.started_at) > timedelta(hours=1):
            out.append(
                Problem(
                    "measurements.stale",
                    "warning",
                    "No measurements for over an hour",
                    "The quarter-hourly recorder read hasn't stored anything.",
                    "See the Measurements runs on the Runs page.",
                    "#/runs?job=measure.sample",
                )
            )

    # Storage: budgets, disk, backups, restores
    storage = x.get("storage")
    if storage is not None:
        for name in storage.over_budget():
            out.append(
                Problem(
                    f"storage.over_budget.{name}",
                    "warning",
                    f"{name} is over its size budget",
                    "The last cleanup cut what it may and the data is still bigger than the budget: a day's worth "
                    "is larger than the budget allows within the floors.",
                    "Raise the budget under Settings → Storage, shorten the retention, or lower the log level.",
                    "#/health?card=storage",
                )
            )
        free, _total = storage.disk()
        if free < storage.disk_low_bytes():
            out.append(
                Problem(
                    "storage.disk_low",
                    "error",
                    "The data disk is nearly full",
                    f"{free // (1024 * 1024)} MiB free where the App keeps its databases",
                    "Free space on the Home Assistant data disk; compaction is skipped until then.",
                    "#/health?card=storage",
                )
            )
        backup = storage.last_backup
        warn_days = settings.storage.backup_warn_days
        if warn_days and backup is not None and backup.get("available") and backup.get("stale"):
            newest = backup.get("newest_at")
            out.append(
                Problem(
                    "backup.stale",
                    "warning",
                    "No recent backup contains EMHASS Lens",
                    f"the newest one is from {newest}" if newest else "no Home Assistant backup includes the App",
                    "Check the Home Assistant Google Drive Backup add-on (full backups, or a partial backup that "
                    "includes EMHASS Lens).",
                    "#/health?card=storage",
                )
            )
        restored = storage.restored()
        if restored is not None and not restored.get("acknowledged"):
            detected = parse_iso_safe(restored.get("detected_at"))
            if detected is not None and now - detected < timedelta(days=7):
                out.append(
                    Problem(
                        "restore.recent",
                        "warning",
                        "Restored from a backup",
                        f"Run history up to #{restored.get('last_run_id')} was not in the backup; agreement "
                        "figures and measured history start from scratch.",
                        "Check the Health page once, then dismiss this on the Storage card.",
                        "#/health?card=storage",
                    )
                )

    if not c.scheduler.started and not c.boot.safe_mode:
        out.append(Problem("scheduler.stopped", "error", "The scheduler is not running", link="#/health"))

    return out


def parse_iso_safe(value: Any) -> datetime | None:
    from emhass_lens.core.clock import parse_iso

    try:
        return parse_iso(str(value)) if value else None
    except ValueError:
        return None
