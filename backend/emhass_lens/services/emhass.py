"""EMHASS: where it is, whether it's healthy, how it's configured, and the plans it produced."""

import asyncio
import gzip
import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any

from emhass_lens.clients.emhass import EmhassClient, EmhassError
from emhass_lens.clients.supervisor import SupervisorClient, SupervisorError, addon_hostname
from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.domain.emhass_checks import Check, run_checks, worst
from emhass_lens.domain.mpc.anchor import parse_version
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.emhass")

DISCOVERED_KEY = "emhass.discovered_url"
HOST_GATEWAY = "172.30.32.1"


class EmhassService:
    def __init__(self, c: Container, client: EmhassClient, supervisor: SupervisorClient) -> None:
        self.c = c
        self.client = client
        self.supervisor = supervisor
        self.url: str | None = None
        self.url_source: str | None = None
        self.reachable: bool | None = None
        self.health: dict[str, Any] | None = None
        self.last_error: str | None = None
        self.last_health_at: datetime | None = None
        self.unreachable_since: datetime | None = None
        self.config: dict[str, Any] | None = None
        self.config_at: datetime | None = None
        self.checks: list[Check] = []
        self.boot_ts: Any = None
        self.discovery_log: list[dict[str, Any]] = []
        self.action_lock = asyncio.Lock()

    # --- facts other services rely on --------------------------------------------------------------
    @property
    def version(self) -> str | None:
        return ((self.health or {}).get("versions") or {}).get("emhass")

    @property
    def version_tuple(self) -> tuple[int, ...] | None:
        return parse_version(self.version)

    def method_ts_round(self) -> str:
        value = (self.config or {}).get("method_ts_round")
        return value if value in ("nearest", "first", "last") else "nearest"

    def config_ok(self) -> bool:
        return worst(self.checks) != "error" if self.checks else False

    # --- address -----------------------------------------------------------------------------------------
    async def resolve(self) -> str | None:
        configured = self.c.settings.current.emhass.base_url
        if configured:
            self._use(configured, "settings")
            return configured
        remembered = self.c.kv_get(DISCOVERED_KEY)
        if remembered:
            try:
                await self.client.probe(remembered)
                self._use(remembered, "discovered")
                return remembered
            except Exception as exc:
                log.info(
                    "Previously discovered EMHASS address %s doesn't answer (%s); searching again", remembered, exc
                )
        found = await self.discover()
        if found:
            self._use(found, "discovered")
        return found

    def _use(self, url: str, source: str) -> None:
        if url != self.url:
            log.info("Using EMHASS at %s (%s)", url, source)
        self.url, self.url_source = url, source
        self.client.set_base_url(url)

    async def discover(self) -> str | None:
        """Look for the EMHASS App through the Supervisor and probe its /healthz."""
        tried: list[dict[str, Any]] = []
        candidates: list[str] = []
        if self.supervisor.available:
            try:
                for addon in await self.supervisor.addons():
                    slug = str(addon.get("slug") or "")
                    if "emhass" not in slug.lower():
                        continue
                    candidates.append(f"http://{addon_hostname(slug)}:5000")
                    try:
                        info = await self.supervisor.addon_info(slug)
                        for host_port in (info.get("network") or {}).values():
                            if host_port:
                                candidates.append(f"http://{HOST_GATEWAY}:{host_port}")
                    except SupervisorError as exc:
                        tried.append({"url": f"addon {slug}", "ok": False, "error": str(exc)})
            except SupervisorError as exc:
                tried.append({"url": "Supervisor /addons", "ok": False, "error": str(exc)})
        else:
            candidates += ["http://localhost:5000", "http://localhost:5001"]
        for url in dict.fromkeys(candidates):
            try:
                health = await self.client.probe(url)
                tried.append({"url": url, "ok": True, "version": (health.get("versions") or {}).get("emhass")})
                self.discovery_log = tried
                await self.c.app_db.run(self.c.kv_set, DISCOVERED_KEY, url)
                log.info("Found EMHASS at %s", url)
                return url
            except Exception as exc:
                tried.append({"url": url, "ok": False, "error": str(exc) or type(exc).__name__})
        already_failed = bool(self.discovery_log) and not any(t.get("ok") for t in self.discovery_log)
        self.discovery_log = tried
        log.log(
            20 if already_failed else 30,
            "EMHASS not found (tried %s)",
            ", ".join(t["url"] for t in tried) or "nothing",
        )
        return None

    # --- health and configuration ------------------------------------------------------------------------
    async def poll_health(self, ctx: JobContext) -> None:
        if not self.url:
            await self.resolve()
        if not self.url:
            self._unreachable("no EMHASS address (set it under Settings → EMHASS)")
            return
        try:
            health = await self.client.healthz()
        except EmhassError as exc:
            self._unreachable(str(exc))
            return
        restarted = self.boot_ts is not None and health.get("boot_ts") != self.boot_ts
        self.health = health
        self.boot_ts = health.get("boot_ts")
        self.last_health_at = self.c.clock.now()
        if self.reachable is not True:
            log.info("EMHASS %s is reachable at %s", self.version, self.url)
        self.reachable, self.last_error, self.unreachable_since = True, None, None
        if restarted or self.config is None:
            if restarted:
                log.info("EMHASS restarted; re-reading its configuration")
            self.c.scheduler.run_now("emhass.config_check")

    def _unreachable(self, error: str) -> None:
        if self.reachable is not False or error != self.last_error:
            log.warning("EMHASS unreachable: %s", error)
        self.reachable, self.last_error = False, error
        if self.unreachable_since is None:
            self.unreachable_since = self.c.clock.now()

    async def check_config(self, ctx: JobContext) -> None:
        if not self.url:
            await self.resolve()
        config: dict[str, Any] | None = None
        error = None
        if self.url:
            try:
                if self.health is None:
                    self.health = await self.client.healthz()
                config = await self.client.get_config()
            except EmhassError as exc:
                error = str(exc)
        self.config = config if isinstance(config, dict) else None
        self.config_at = self.c.clock.now()
        ha_tz = self.c.extras["ha"].time_zone
        self.checks = run_checks(self.config, self.version, self.c.settings.current, ha_tz)
        status = worst(self.checks)
        summary = f"EMHASS {self.version or '?'}: " + ", ".join(
            f"{c.title} {c.status}" for c in self.checks if c.status not in ("ok", "info")
        )
        if ctx.run:
            ctx.run.artifact("checks", [c.as_dict() for c in self.checks])
            if self.config:
                ctx.run.artifact("emhass_config", self.config)
            ctx.run.summary = summary if status != "ok" else f"EMHASS {self.version or '?'}: configuration OK"
            if error:
                ctx.run.outcome, ctx.run.error = "error", error

    # --- plans -------------------------------------------------------------------------------------------
    async def watch_plan(self, ctx: JobContext, *, driver: str = "external", run_id: int | None = None) -> bool:
        """Store the EMHASS plan if it is newer than the last one stored. True if a new plan was stored."""
        if not self.url:
            await self.resolve()
        if not self.url:
            if ctx.run:
                ctx.run.outcome, ctx.run.summary = "noop", "No EMHASS address"
            return False
        try:
            last_run = await self.client.last_run()
        except EmhassError as exc:
            if ctx.run:
                ctx.run.outcome, ctx.run.error = "error", str(exc)
            return False
        newest = await self.c.app_db.aquery_one(
            "SELECT generated_at FROM plan_snapshot ORDER BY generated_at DESC LIMIT 1"
        )
        stamp = last_run.get("timestamp")
        if not stamp or (newest and newest["generated_at"] >= str(stamp)):
            if ctx.run:
                ctx.run.outcome = "noop"
                ctx.run.summary = f"No new plan (last run {stamp or 'none'}, status {last_run.get('status')})"
            return False
        try:
            plan = await self.client.plan()
        except EmhassError as exc:
            if ctx.run:
                ctx.run.outcome, ctx.run.error = "error", str(exc)
            return False
        if plan.get("status") != "ok" or not plan.get("plan"):
            if ctx.run:
                ctx.run.outcome, ctx.run.summary = "noop", f"No plan available ({plan.get('status')})"
            return False
        generated = str(plan.get("generated_at"))
        stored = await self.c.app_db.run(self._store_plan, generated, driver, run_id, last_run, plan)
        if ctx.run:
            rows = len(plan.get("plan") or [])
            ctx.run.summary = f"Plan of {generated} ({rows} slots, {last_run.get('status')}, driver {driver})"
            ctx.run.artifact("last_run", last_run)
        return stored

    def _store_plan(
        self, generated: str, driver: str, run_id: int | None, last_run: dict[str, Any], plan: dict[str, Any]
    ) -> bool:
        cur = self.c.app_db.execute(
            "INSERT OR IGNORE INTO plan_snapshot (generated_at, fetched_at, driver, run_id, last_run_json, plan_gz) "
            "VALUES (?,?,?,?,?,?)",
            (
                generated,
                iso(self.c.clock.now()),
                driver,
                run_id,
                json.dumps(last_run, default=str),
                gzip.compress(json.dumps(plan, default=str).encode()),
            ),
        )
        return cur.rowcount > 0

    async def plans(self, limit: int = 2) -> list[dict[str, Any]]:
        rows = await self.c.app_db.aquery(
            "SELECT id, generated_at, fetched_at, driver, run_id, last_run_json, plan_gz FROM plan_snapshot "
            "ORDER BY generated_at DESC LIMIT ?",
            (limit,),
        )
        out = []
        for row in rows:
            body = json.loads(gzip.decompress(row.pop("plan_gz")))
            row["last_run"] = json.loads(row.pop("last_run_json") or "null")
            row["plan"] = body.get("plan") or []
            row["emhass_schema_version"] = body.get("emhass_schema_version")
            out.append(row)
        return out

    def prune(self, keep: int = 2000) -> int:
        return self.c.app_db.execute(
            "DELETE FROM plan_snapshot WHERE id NOT IN "
            "(SELECT id FROM plan_snapshot ORDER BY generated_at DESC LIMIT ?)",
            (keep,),
        ).rowcount

    def status(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "url_source": self.url_source,
            "reachable": self.reachable,
            "version": self.version,
            "last_error": self.last_error,
            "last_health_at": iso(self.last_health_at),
            "unreachable_since": iso(self.unreachable_since),
            "method_ts_round": self.method_ts_round(),
            "config_at": iso(self.config_at),
            "checks": [c.as_dict() for c in self.checks],
            "checks_status": worst(self.checks) if self.checks else "unknown",
            "health": self.health,
            "discovery": self.discovery_log,
            "boot_ts": self.boot_ts if not isinstance(self.boot_ts, datetime) else iso(self.boot_ts),
        }


def parse_ts(value: Any) -> datetime | None:
    return parse_iso(str(value)) if value else None
