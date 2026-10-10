"""EMHASS: where it is, whether it's healthy, how it's configured, and the plans it produced."""

import asyncio
import gzip
import json
import logging
import re
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.clients.emhass import EmhassClient, EmhassError
from emhass_lens.clients.supervisor import SupervisorClient, SupervisorError, addon_hostname
from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.emhass_checks import Check, run_checks, worst
from emhass_lens.domain.mpc.anchor import parse_version
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.emhass")

DISCOVERED_KEY = "emhass.discovered_url"
HOST_GATEWAY = "172.30.32.1"
# The EMHASS App from https://github.com/davidusb-geek/emhass-add-on (Supervisor slug = sha1(repo url)[:8]_emhass),
# and the same App installed as a local App.
KNOWN_SLUGS = ("5b918bf2_emhass", "local_emhass")
PLAN_ROW_DAYS = 14  # how far back plan_row keeps the per-slot plan columns (the accuracy view's reach)
_DEFERRABLE = re.compile(r"^P_deferrable\d+$")


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def plan_rows(snapshot_id: int, plan: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    """plan_row records of a plan: slot normalised to UTC, the power columns, the deferrable total and the
    (first) battery's SOC."""
    out: list[tuple[Any, ...]] = []
    for row in plan:
        stamp = parse_iso(str(row.get("timestamp"))) if row.get("timestamp") else None
        if stamp is None:
            continue
        deferrables = [_num(v) for k, v in row.items() if _DEFERRABLE.match(k)]
        known = [d for d in deferrables if d is not None]
        soc = _num(row.get("SOC_opt"))
        if soc is None:
            soc = _num(row.get("SOC_opt_0"))
        out.append(
            (
                snapshot_id,
                iso(slot_floor(stamp)),
                _num(row.get("P_grid")),
                _num(row.get("P_batt")),
                _num(row.get("P_PV")),
                _num(row.get("P_Load")),
                sum(known) if known else None,
                soc,
            )
        )
    return out


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
        """Look for the EMHASS App through the Supervisor and probe its /healthz.

        Listing all Apps needs a higher Supervisor role than EMHASS Lens asks for, so when that is refused
        the known slugs of the EMHASS App are looked up directly (/addons/<slug>/info is always allowed).
        """
        tried: list[dict[str, Any]] = []
        candidates: list[str] = []
        if self.supervisor.available:
            slugs: list[str] = []
            try:
                slugs = [
                    str(a.get("slug"))
                    for a in await self.supervisor.addons()
                    if "emhass" in str(a.get("slug", "")).lower()
                ]
            except SupervisorError as exc:
                tried.append(
                    {"url": "Supervisor /addons", "ok": False, "error": f"{exc} — trying the known EMHASS slugs"}
                )
            for slug in slugs or list(KNOWN_SLUGS):
                try:
                    info = await self.supervisor.addon_info(slug)
                except SupervisorError as exc:
                    tried.append({"url": f"App {slug}", "ok": False, "error": str(exc)})
                    continue
                if info.get("state") not in (None, "started"):
                    tried.append({"url": f"App {slug}", "ok": False, "error": f"App is {info.get('state')}"})
                candidates.append(f"http://{addon_hostname(slug)}:5000")
                for host_port in (info.get("network") or {}).values():
                    if host_port:
                        candidates.append(f"http://{HOST_GATEWAY}:{host_port}")
            candidates += [f"http://{HOST_GATEWAY}:5000", f"http://{HOST_GATEWAY}:5001"]
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
            check = self.c.scheduler.jobs.get("emhass.config_check")
            if check is None or not check.running:  # at start the configuration check is already on its way
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
        if driver == "external" and self.action_lock.locked():
            # EMHASS Lens itself is running an action; its MPC run stores (and claims) the plan
            if ctx.run:
                ctx.run.outcome, ctx.run.summary = "noop", "EMHASS Lens is running an EMHASS action"
            return False
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
        def write(conn: Any) -> bool:
            cur = conn.execute(
                "INSERT OR IGNORE INTO plan_snapshot "
                "(generated_at, fetched_at, driver, run_id, last_run_json, plan_gz) "
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
            if cur.rowcount <= 0:
                return False
            conn.executemany(_PLAN_ROW_INSERT, plan_rows(int(cur.lastrowid), plan.get("plan") or []))
            return True

        return self.c.app_db.transaction(write)

    def index_plan_rows(self, now: datetime) -> int:
        """Fill plan_row for stored plans that don't have rows yet (plans stored before plan_row existed).
        Runs in a worker thread; returns the number of plans indexed."""
        cut = iso(now - timedelta(days=PLAN_ROW_DAYS))
        rows = self.c.app_db.query(
            "SELECT id, plan_gz FROM plan_snapshot WHERE fetched_at >= ? "
            "AND id NOT IN (SELECT DISTINCT snapshot_id FROM plan_row) ORDER BY id",
            (cut,),
        )
        for row in rows:
            body = json.loads(gzip.decompress(row["plan_gz"]))
            self.c.app_db.executemany(_PLAN_ROW_INSERT, plan_rows(int(row["id"]), body.get("plan") or []))
        if rows:
            log.info("Indexed the slots of %d stored plans for the accuracy view", len(rows))
        return len(rows)

    def snapshots_between(self, start: datetime, end: datetime) -> list[tuple[int, datetime]]:
        """(id, generated_at) of the plans fetched in [start, end], sorted by generated_at as datetimes
        (the stored text may carry EMHASS's local offset)."""
        rows = self.c.app_db.query(
            "SELECT id, generated_at FROM plan_snapshot WHERE fetched_at >= ? AND fetched_at <= ?",
            (iso(start), iso(end)),
        )
        out: list[tuple[int, datetime]] = []
        for row in rows:
            stamp = parse_iso(row["generated_at"])
            if stamp is not None:
                out.append((int(row["id"]), stamp))
        out.sort(key=lambda s: s[1])
        return out

    def plan_rows_for(self, wanted: list[tuple[int, str]]) -> dict[tuple[int, str], dict[str, Any]]:
        """plan_row records for (snapshot id, slot_utc) pairs."""
        if not wanted:
            return {}
        ids = sorted({sid for sid, _ in wanted})
        slots = [s for _, s in wanted]
        marks = ",".join("?" * len(ids))
        rows = self.c.app_db.query(
            f"SELECT * FROM plan_row WHERE snapshot_id IN ({marks}) AND slot_utc >= ? AND slot_utc <= ?",
            (*ids, min(slots), max(slots)),
        )
        asked = set(wanted)
        return {(r["snapshot_id"], r["slot_utc"]): r for r in rows if (r["snapshot_id"], r["slot_utc"]) in asked}

    async def claim_plan(self, generated_at: str, run_id: int) -> bool:
        """Mark the stored plan with this generated_at as made by EMHASS Lens run `run_id`. False if not stored."""
        stamp = parse_iso(generated_at)
        if stamp is None:
            return False

        def go() -> bool:
            rows = self.c.app_db.query("SELECT id, generated_at FROM plan_snapshot ORDER BY generated_at DESC LIMIT 5")
            for row in rows:
                if parse_iso(row["generated_at"]) == stamp:
                    self.c.app_db.execute(
                        "UPDATE plan_snapshot SET driver = 'app', run_id = ? WHERE id = ?", (run_id, row["id"])
                    )
                    return True
            return False

        return await self.c.app_db.run(go)

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

    def prune(self, keep: int = 2000, now: datetime | None = None) -> int:
        removed = self.c.app_db.execute(
            "DELETE FROM plan_snapshot WHERE id NOT IN "
            "(SELECT id FROM plan_snapshot ORDER BY generated_at DESC LIMIT ?)",
            (keep,),
        ).rowcount
        cut = iso((now or self.c.clock.now()) - timedelta(days=PLAN_ROW_DAYS))
        self.c.app_db.execute("DELETE FROM plan_row WHERE slot_utc < ?", (cut,))
        return removed

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


_PLAN_ROW_INSERT = (
    "INSERT OR REPLACE INTO plan_row (snapshot_id, slot_utc, p_grid, p_batt, p_pv, p_load, p_deferrable, soc) "
    "VALUES (?,?,?,?,?,?,?,?)"
)
