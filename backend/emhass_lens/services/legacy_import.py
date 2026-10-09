"""Imports the HACS integration's settings (tariffs, API key, forecast choices) into EMHASS Lens."""

import logging
from typing import TYPE_CHECKING, Any

from emhass_lens.domain.tariffs.packages import PACKAGES

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.legacy")

DOMAIN = "nordpool_ee_scraper"
FORECAST_OPTIONS = {
    "Finland (FI) - nordpool-predict-fi": "fi_ha_entity",
    "Finland (FI)": "fi_ha_entity",
    "Estonia (EE) - eupowerprices.com": "ee_eupowerprices",
    "Estonia (EE)": "ee_eupowerprices",
    "None": "none",
}
TARIFF_KEYS = {
    "margin": "margin",
    "taastuv": "renewable",
    "aktsiis": "excise",
    "tasakaal": "balancing",
    "varustus": "supply_security",
    "vat": "vat_pct",
    "export_margin": "export_margin",
    "export_tasakaal": "export_balancing",
}


async def read_options(c: Container) -> tuple[dict[str, Any] | None, str | None]:
    """The integration's current options, read through an options flow that is then discarded."""
    ha = c.extras["ha"]
    resp = await ha.rest.get(f"/api/config/config_entries/entry?domain={DOMAIN}")
    if resp.status_code != 200:
        return None, f"listing config entries failed (HTTP {resp.status_code})"
    entries = resp.json()
    if not entries:
        return None, "the HACS integration isn't installed"
    entry_id = entries[0]["entry_id"]
    flow = await ha.post("/api/config/config_entries/options/flow", {"handler": entry_id})
    if flow.status_code != 200:
        return None, f"opening the options flow failed (HTTP {flow.status_code})"
    body = flow.json()
    try:
        options = {f["name"]: f.get("default") for f in body.get("data_schema") or [] if "name" in f}
    finally:
        if body.get("flow_id"):
            await ha.delete(f"/api/config/config_entries/options/flow/{body['flow_id']}")
    return options, None


async def preview(c: Container) -> dict[str, Any]:
    ha = c.extras["ha"]
    prefix = c.settings.current.parity.legacy_prefix
    notes: list[str] = []
    changes: dict[str, Any] = {}

    options, error = await read_options(c)
    if error:
        notes.append(f"Tariffs not imported: {error}. Enter them under Settings → Prices.")
    if options:
        tariff: dict[str, Any] = {}
        for old, new in TARIFF_KEYS.items():
            if options.get(old) is not None:
                tariff[new] = float(options[old])
        day, night = options.get("elektrilevi_day"), options.get("elektrilevi_night")
        if day is not None and night is not None:
            tariff["package"] = "custom"
            tariff["network"] = {"day": float(day), "night": float(night)}
            match = [
                k for k, p in PACKAGES.items() if abs(p.day - float(day)) < 1e-6 and abs(p.night - float(night)) < 1e-6
            ]
            if match:
                notes.append(
                    f"Network rates match {PACKAGES[match[0]].label}; kept as custom rates so prices stay identical."
                )
        changes["prices"] = {"tariff": tariff}
        nordpool: dict[str, Any] = {}
        if options.get("fast_interval"):
            nordpool["fast_interval_min"] = int(options["fast_interval"])
        if options.get("slow_interval"):
            nordpool["slow_interval_min"] = int(float(options["slow_interval"]) * 60)
        if nordpool:
            changes["prices"]["nordpool"] = nordpool
        if options.get("api_key"):
            changes.setdefault("forecast", {})["ee"] = {"api_key": options["api_key"]}

    async def state(entity_id: str) -> dict[str, Any] | None:
        try:
            return await ha.get_state(entity_id)
        except Exception:
            return None

    source = await state(f"select.{prefix}forecast_source")
    if source and source.get("state") in FORECAST_OPTIONS:
        changes.setdefault("forecast", {})["source"] = FORECAST_OPTIONS[source["state"]]
    extend = await state(f"number.{prefix}forecast_extend_days")
    if extend and _number(extend):
        changes.setdefault("forecast", {})["extend_days"] = int(_number(extend) or 1)
    poll = await state(f"number.{prefix}forecast_poll_interval")
    if poll and _number(poll):
        changes.setdefault("forecast", {}).setdefault("ee", {})["poll_hours"] = int(_number(poll) or 1)
    interval = await state(f"number.{prefix}emhass_mpc_interval")
    if interval and _number(interval) not in (None, 15.0):
        notes.append(
            f"The integration ran MPC every {int(_number(interval) or 0)} min; EMHASS Lens runs every quarter-hour."
        )
    auto = await state(f"switch.{prefix}emhass_auto_mpc")
    if auto:
        notes.append(
            "The integration's Auto MPC is " + auto.get("state", "?") + ". EMHASS Lens takes over later with "
            "'Take over' on the Health page; until then it only builds payloads."
        )
    found = bool(options) or any(x is not None for x in (source, extend, poll, interval, auto))
    return {"found": found, "changes": changes, "notes": notes}


def _number(state: dict[str, Any]) -> float | None:
    try:
        return float(state.get("state"))  # type: ignore[arg-type]
    except TypeError, ValueError:
        return None
