"""Compares EMHASS Lens with the HACS integration while both run (Phases 1–2).

Every quarter, a few seconds after both have built their MPC payload, this reads the
integration's entities and compares, slot by slot:
- import/export prices (timestamped, from import_cost / export_cost), with legacy-compatible math;
- the "prices from now" lists and the 15-minute Solcast list (positional, as the integration sent them);
- the last MPC payload the integration sent, against our build of the same quarter.
Known, intended differences are labelled so only unexplained ones need attention. One of them: both
sides fetch the price forecast on their own schedule, so slots filled from the forecast differ
whenever the provider revised it between the two fetches.
"""

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain import price_compare
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.parity")

MAX_LISTED = 12
# Fetches closer together than this got the same forecast, so their slots must match.
SAME_FETCH = timedelta(minutes=2)


def compare_lists(
    name: str,
    ours: list[float],
    theirs: list[float],
    tolerance: float,
    labels: list[str] | None = None,
    forecast: list[bool] | None = None,
) -> dict[str, Any]:
    """Positional comparison. With `forecast` (per slot: filled from a price forecast) the result
    also counts how many differences are in forecast slots."""
    n = min(len(ours), len(theirs))
    diffs = []
    in_forecast = 0
    for i in range(n):
        if abs(float(ours[i]) - float(theirs[i])) > tolerance:
            if forecast is not None and i < len(forecast) and forecast[i]:
                in_forecast += 1
            diffs.append(
                {
                    "i": i,
                    "slot": labels[i] if labels and i < len(labels) else None,
                    "ours": ours[i],
                    "legacy": theirs[i],
                    "delta": round(float(ours[i]) - float(theirs[i]), 6),
                }
            )
    out = {
        "name": name,
        "ours_len": len(ours),
        "legacy_len": len(theirs),
        "compared": n,
        "equal": n - len(diffs),
        "different": len(diffs),
        "examples": diffs[:MAX_LISTED],
        "ok": not diffs and len(ours) == len(theirs),
    }
    if forecast is not None:
        out["different_in_forecast"] = in_forecast
    return out


def _timestamp(value: Any) -> datetime | None:
    """A timestamp sensor's state, or None for unknown / unavailable / missing."""
    try:
        return parse_iso(str(value)) if value else None
    except ValueError:
        return None


class ParityService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.last_report: dict[str, Any] | None = None

    def entity(self, suffix: str) -> str:
        return f"sensor.{self.c.settings.current.parity.legacy_prefix}{suffix}"

    async def run(self, ctx: JobContext) -> None:
        assert ctx.run is not None
        settings = self.c.settings.current
        ha = self.c.extras["ha"]
        if not ha.connected:
            ctx.run.outcome, ctx.run.summary = "noop", "Not connected to Home Assistant"
            return
        sections: list[dict[str, Any]] = []
        legacy_found = False
        if settings.parity.enabled:
            names = (
                "import_cost",
                "export_cost",
                "prices_from_now",
                "solcast_forecast_15min",
                "emhass_last_mpc",
                "forecast_api_last_poll",
            )
            states: dict[str, dict[str, Any] | None] = {}
            for name in names:
                try:
                    states[name] = await ha.get_state(self.entity(name))
                except Exception as exc:
                    states[name] = None
                    log.debug("Reading %s failed: %s", self.entity(name), exc)
            legacy_found = any(v is not None for v in states.values())
            if legacy_found:
                tol = settings.parity.tolerance
                legacy_poll = _timestamp((states.get("forecast_api_last_poll") or {}).get("state"))
                sections += self._timestamped(states, tol)
                sections += self._from_now(states, tol)
                payload = self._payload(states, legacy_poll)
                if payload:
                    sections.append(payload)
                for section in sections:
                    if not section.get("ok") and not section.get("explained"):
                        note = self._forecast_only(section, legacy_poll)
                        if note:
                            section["explained"] = note
        sensor_sections = await self._price_sensors()
        sections += sensor_sections
        if not sections:
            ctx.run.outcome = "noop"
            if not settings.parity.enabled and not self._sensor_entities():
                ctx.run.summary = "Parity checks are off and no price sensor is set"
            elif settings.parity.enabled and not legacy_found and not self._sensor_entities():
                ctx.run.summary = f"HACS integration not found ({self.entity('import_cost')} missing)"
            else:
                ctx.run.summary = "Nothing to compare: the HACS integration and the price sensors weren't found"
            return

        unexplained = [s for s in sections if not s.get("ok") and not s.get("explained")]
        report = {"checked_at": iso(self.c.clock.now()), "sections": sections, "ok": not unexplained}
        self.last_report = report
        ctx.run.artifact("parity", report)
        parts = []
        for s in sections:
            if "compared" in s:
                parts.append(f"{s['name']} {s['equal']}/{s['compared']}" + ("" if s.get("ok") else " ≠"))
            else:
                parts.append(f"{s['name']} {'=' if s.get('ok') else '≠'}")
        ctx.run.summary = ", ".join(parts)
        ctx.run.outcome = "ok" if report["ok"] else "mismatch"
        if not report["ok"]:
            log.warning("Parity differences: %s", "; ".join(s["name"] for s in unexplained))

    def _forecast_only(self, section: dict[str, Any], legacy_poll: datetime | None) -> str | None:
        """Why a list differs, when every difference is in slots filled from the price forecast and the
        two sides fetched that forecast at different times; None when that doesn't explain it."""
        different = section.get("different") or 0
        if not different or section.get("different_in_forecast") != different:
            return None
        if section.get("ours_len") != section.get("legacy_len"):
            return None
        fetch = self.c.extras["forecasts"].current()
        ours_at = fetch.fetched_at if fetch else None
        if ours_at and legacy_poll and abs(ours_at - legacy_poll) <= SAME_FETCH:
            return None  # same forecast: these slots should have matched
        if ours_at and legacy_poll:
            when = f"EMHASS Lens at {self._local_time(ours_at)}, the integration at {self._local_time(legacy_poll)}"
        else:
            when = "each fetches it on its own schedule"
        return f"only forecast slots differ: the price forecast was fetched at different times ({when})"

    # --- the owner's own price sensors ------------------------------------------------------------------
    def _sensor_entities(self) -> list[tuple[str, str]]:
        sensors = self.c.settings.current.prices.sensors
        out = []
        if sensors.import_entity:
            out.append((sensors.import_entity, "import_price"))
        if sensors.export_entity:
            out.append((sensors.export_entity, "export_price"))
        return out

    async def _price_sensors(self) -> list[dict[str, Any]]:
        """A Nord Pool template sensor with fees (raw_today / raw_tomorrow / raw_all) against our priced slots."""
        settings = self.c.settings.current
        ha = self.c.extras["ha"]
        out: list[dict[str, Any]] = []
        for entity, field in self._sensor_entities():
            try:
                state = await ha.get_state(entity)
            except Exception as exc:
                log.debug("Reading %s failed: %s", entity, exc)
                state = None
            if state is None:
                out.append(
                    {
                        "name": entity,
                        "theirs_label": entity,
                        "ok": False,
                        "missing": True,
                        "explained": f"{entity} wasn't found in Home Assistant (Settings → Prices → Compare with "
                        "your price sensors)",
                    }
                )
                continue
            intervals = price_compare.sensor_intervals(state.get("attributes"))
            if not intervals:
                out.append(
                    {
                        "name": entity,
                        "theirs_label": entity,
                        "ok": False,
                        "missing": True,
                        "explained": f"{entity} has no raw_today / raw_tomorrow / raw_all list with prices",
                    }
                )
                continue
            ours = self.c.extras["prices"].priced(intervals[0].start, self.c.extras["forecasts"].current())
            sensors = settings.prices.sensors
            section = price_compare.compare(
                entity,
                intervals,
                ours,
                field,
                sensors.tolerance,
                spot_decimals=sensors.spot_decimals,
                vat_factor=1 + settings.prices.tariff.vat_pct / 100,
            )
            if not section["ok"]:
                # a cause, not an excuse: the sensor is still different, so the run says mismatch
                note = price_compare.explain(section, settings.prices.tariff, field, settings.prices.sensors.tolerance)
                if note:
                    section["note"] = note
            out.append(section)
        return out

    def _local_time(self, at: datetime) -> str:
        """HH:MM in Home Assistant's timezone (the App's own when HA hasn't said yet)."""
        try:
            zone = ZoneInfo(self.c.extras["ha"].time_zone or self.c.boot.tz)
        except Exception:
            zone = ZoneInfo("UTC")
        return at.astimezone(zone).strftime("%H:%M")

    # --- sections -------------------------------------------------------------------------------------
    def _timestamped(self, states: dict[str, dict[str, Any] | None], tol: float) -> list[dict[str, Any]]:
        out = []
        prices_svc = self.c.extras["prices"]
        starts = [
            parse_iso(item.get("start"))
            for name in ("import_cost", "export_cost")
            for item in (((states.get(name) or {}).get("attributes") or {}).get("prices") or [])
        ]
        first = min((s for s in starts if s is not None), default=None)
        if first is None:
            return out
        ours = prices_svc.priced(first, self.c.extras["forecasts"].current(), legacy_compat=True)
        by_start = {p.start: p for p in ours}
        for name, attr in (("import_cost", "import_price"), ("export_cost", "export_price")):
            state = states.get(name)
            legacy = ((state or {}).get("attributes") or {}).get("prices") or []
            pairs_ours, pairs_theirs, labels, forecast = [], [], [], []
            missing = 0
            for item in legacy:
                start = parse_iso(item.get("start"))
                if start is None:
                    continue
                mine = by_start.get(start)
                if mine is None:
                    missing += 1
                    continue
                pairs_ours.append(getattr(mine, attr))
                pairs_theirs.append(float(item.get("value")))
                labels.append(iso(start) or "")
                forecast.append(mine.is_forecast)
            if not legacy:
                continue
            section = compare_lists(f"{name} (timestamped)", pairs_ours, pairs_theirs, tol, labels, forecast)
            section["legacy_slots_without_ours"] = missing
            section["ok"] = section["different"] == 0 and missing == 0
            out.append(section)
        return out

    def _from_now(self, states: dict[str, dict[str, Any] | None], tol: float) -> list[dict[str, Any]]:
        out = []
        state = states.get("prices_from_now")
        if state:
            attrs = state.get("attributes") or {}
            at = parse_iso(state.get("last_updated")) or self.c.clock.now()
            ours = [
                p
                for p in self.c.extras["prices"].priced(
                    slot_floor(at), self.c.extras["forecasts"].current(), legacy_compat=True
                )
                if p.end > at
            ]
            labels = [iso(p.start) or "" for p in ours]
            forecast = [p.is_forecast for p in ours]
            out.append(
                compare_lists(
                    "prices_from_now import",
                    [p.import_price for p in ours],
                    attrs.get("import_prices") or [],
                    tol,
                    labels,
                    forecast,
                )
            )
            out.append(
                compare_lists(
                    "prices_from_now export",
                    [p.export_price for p in ours],
                    attrs.get("export_prices") or [],
                    tol,
                    labels,
                    forecast,
                )
            )
        sol = states.get("solcast_forecast_15min")
        pv = self.c.extras["pv"].current()
        if sol and pv is not None:
            at = parse_iso(sol.get("last_updated")) or self.c.clock.now()
            theirs = (sol.get("attributes") or {}).get("values") or []
            starts = [slot_floor(at) + timedelta(minutes=15 * i) for i in range(len(theirs))]
            mine, _ = pv.series(starts)
            section = compare_lists(
                "solcast 15 min", [round(v) for v in mine], theirs, 1.0, [iso(s) or "" for s in starts]
            )
            if not section["ok"] and all(abs(d["delta"]) <= 1 for d in section["examples"]):
                section["explained"] = "the integration truncated watts with int()"
            out.append(section)
        return out

    def _payload(self, states: dict[str, dict[str, Any] | None], legacy_poll: datetime | None) -> dict[str, Any] | None:
        state = states.get("emhass_last_mpc")
        shadow = self.c.extras["mpc"].last_shadow
        if not state or shadow is None or shadow.compat is None:
            return None
        attrs = state.get("attributes") or {}
        theirs = attrs.get("payload")
        legacy_at = parse_iso(state.get("state"))
        if not isinstance(theirs, dict) or legacy_at is None:
            return None
        if slot_floor(legacy_at) != slot_floor(shadow.built_at):
            return {
                "name": "MPC payload",
                "ok": True,
                "explained": "not the same quarter",
                "legacy_run": iso(legacy_at),
                "our_build": iso(shadow.built_at),
            }
        ours = shadow.compat.payload
        forecast_slots = [str(row.get("origin", "actual")) != "actual" for row in shadow.compat.explain]
        keys = sorted(set(ours) | set(theirs))
        diffs = []
        explained = []
        for key in keys:
            a, b = ours.get(key), theirs.get(key)
            if a == b:
                continue
            if (
                key in ("soc_init", "soc_final")
                and isinstance(a, (int, float))
                and isinstance(b, (int, float))
                and abs(a - b) <= 0.02
            ):
                explained.append(f"{key}: read at a slightly different time ({a} vs {b})")
                continue
            if (
                key == "end_timesteps_of_each_deferrable_load"
                and isinstance(a, list)
                and isinstance(b, list)
                and all(x == y - 1 for x, y in zip(a, b, strict=False) if y)
            ):
                explained.append(
                    "deadline counted from the anchor slot (fixes the integration's one-slot-late deadline)"
                )
                continue
            if (
                key == "pv_power_forecast"
                and isinstance(a, list)
                and isinstance(b, list)
                and len(a) == len(b)
                and all(abs(x - y) <= 1 for x, y in zip(a, b, strict=True))
            ):
                explained.append("PV watts differ by ≤ 1 W (int() truncation)")
                continue
            if (
                key in ("load_cost_forecast", "prod_price_forecast", "pv_power_forecast")
                and isinstance(a, list)
                and isinstance(b, list)
            ):
                section = compare_lists(key, a, b, 1e-9, forecast=forecast_slots)
                note = self._forecast_only(section, legacy_poll) if key != "pv_power_forecast" else None
                if note:
                    explained.append(f"{key}: {note}")
                    continue
                diffs.append(
                    {
                        "key": key,
                        "lengths": [len(a), len(b)],
                        "different": section["different"],
                        "examples": section["examples"][:5],
                    }
                )
            else:
                diffs.append({"key": key, "ours": a, "legacy": b})
        return {
            "name": "MPC payload",
            "ok": not diffs,
            "differences": diffs,
            "explained_differences": explained,
            "legacy_run": iso(legacy_at),
            "our_build": iso(shadow.built_at),
            "our_run_id": shadow.run_id,
        }
