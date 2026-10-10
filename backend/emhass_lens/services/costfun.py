"""Cost functions: which one EMHASS optimises for, and a comparison of all three with the same inputs.

A comparison sends the payload of the moment with each of the other two cost functions, reads each plan
back, and then runs the method in use, so EMHASS ends up holding the real plan (every optimisation
replaces EMHASS's latest plan, which publish-data and /api/v1/plan read). The whole sequence holds the
EMHASS action lock, so neither the plan watch nor a publish can slip in between.
"""

import gzip
import json
import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.domain.mpc.compare import COSTFUNS, LABEL, costfun_of, plan_totals
from emhass_lens.domain.mpc.model_steps import short_model
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container
    from emhass_lens.services.mpc import Built

log = logging.getLogger("emhass_lens.costfun")

KEEP_DAYS = 30


class CostfunCompareService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.ignored: str | None = None  # set when EMHASS used another cost function than requested
        self.last_compared_at: datetime | None = None

    # --- facts ------------------------------------------------------------------------------------------
    def live_costfun(self) -> tuple[str, str]:
        """(method in use, where that is known from): the setting, else EMHASS's configuration, else assumed."""
        chosen = self.c.settings.current.emhass.mpc.costfun
        if chosen != "default":
            return chosen, "settings"
        configured = (self.c.extras["emhass"].config or {}).get("costfun")
        if configured in COSTFUNS:
            return str(configured), "emhass_config"
        return "profit", "assumed"

    def cannot_run(self) -> str | None:
        """Why a comparison can't run right now, or None."""
        mpc = self.c.extras["mpc"]
        emhass = self.c.extras["emhass"]
        if mpc.mode == "off":
            return "the mode is Off (EMHASS is never called)"
        if emhass.reachable is not True:
            return f"EMHASS is not reachable ({emhass.last_error or 'unknown'})"
        if mpc.legacy_driving():
            return "the HACS integration's Auto MPC is on; its publish would pick up a comparison plan"
        if self.c.extras.get("ml_running"):
            return "an ML model fit is running in EMHASS"
        external = self.c.extras.get("external")
        if external is not None and external.holding:
            return "a market session holds the inverter"
        return None

    # --- the job -----------------------------------------------------------------------------------------
    async def run(self, ctx: JobContext) -> None:
        """Compare now: the other two methods, then the one in use (which becomes EMHASS's plan)."""
        assert ctx.run is not None
        why = self.cannot_run()
        if why:
            raise RunRefused(f"Can't compare cost functions: {why}")
        mpc = self.c.extras["mpc"]
        built = await mpc.build_now(ctx, send=True)
        if built.blocking:
            raise RunRefused("; ".join(i.message for i in built.blocking))
        await self.compare_then_send(ctx, built)

    async def compare_then_send(self, ctx: JobContext, built: Built) -> None:
        """Run the other two methods, then send the method in use through the normal live path."""
        assert ctx.run is not None
        emhass = self.c.extras["emhass"]
        mpc = self.c.extras["mpc"]
        live, _source = self.live_costfun()
        now = self.c.clock.now()
        async with emhass.action_lock:
            results, short_body = await self._alternatives(ctx, built, live)
            if short_body is None:
                await mpc.send(ctx, built.result, built.horizon, built.warn_note, locked=True)
        if short_body is not None:
            # EMHASS's load model can't cover the horizon: no method can plan it; plan again with it cut
            await mpc.on_short_model(ctx, short_body)
            return
        results.append(await self._live_entry(ctx, built, live))
        await self.c.app_db.run(self._store, ctx.run.id, now, built.anchor, results)
        self.last_compared_at = now
        head = self.describe(results, built)
        ctx.run.summary = f"{head} · {ctx.run.summary}" if ctx.run.summary else head

    async def _alternatives(self, ctx: JobContext, built: Built, live: str) -> tuple[list[dict[str, Any]], str | None]:
        """The other methods' plans, and EMHASS's answer when its load model is shorter than the horizon (then the
        comparison stops: no method can plan it)."""
        assert ctx.run is not None
        emhass = self.c.extras["emhass"]
        timeout = self.c.settings.current.emhass.timeouts.mpc
        out: list[dict[str, Any]] = []
        for method in COSTFUNS:
            if method == live:
                continue
            payload = {**built.result.payload, "costfun": method}
            sent_at = self.c.clock.now()
            entry: dict[str, Any] = {
                "costfun": method,
                "live": False,
                "optim_status": None,
                "duration_ms": None,
                "problem": None,
                "generated_at": None,
                "rows": [],
                "totals": None,
            }
            response = await emhass.act("naive-mpc-optim", payload, timeout)
            entry["duration_ms"] = response.duration_ms
            if response.error:
                entry["problem"] = response.error
                out.append(entry)
                ctx.run.artifact(f"costfun:{method}", {**entry, "rows": None, "rows_count": len(entry["rows"])})
                if short_model(response.body) is not None:
                    return out, response.body
                continue
            try:
                last_run = await emhass.client.last_run()
            except Exception as exc:
                last_run = {"status": "unknown", "error_message": str(exc)}
            status = last_run.get("status")
            entry["optim_status"] = status
            stamp = parse_iso(str(last_run.get("timestamp"))) if last_run.get("timestamp") else None
            if stamp is None or stamp < sent_at.replace(microsecond=0):
                entry["problem"] = (
                    f"EMHASS answered, but its last run ({last_run.get('timestamp')}) is older than this request"
                )
            elif status != "ok":
                entry["problem"] = last_run.get("error_message") or f"EMHASS reported {status}"
            else:
                plan = await emhass.client.plan()
                rows = plan.get("plan") or []
                used = costfun_of(rows)
                if used != method:
                    self.ignored = (
                        f"EMHASS {emhass.version or '?'} made the plan with "
                        f"{used or 'its configured cost function'} although {method} was requested"
                    )
                    entry["problem"] = self.ignored + ": this EMHASS ignores the costfun runtime parameter"
                else:
                    self.ignored = None
                    entry["generated_at"] = plan.get("generated_at")
                    entry["rows"] = rows
                    entry["totals"] = plan_totals(
                        rows,
                        load_cost=payload.get("load_cost_forecast"),
                        prod_price=payload.get("prod_price_forecast"),
                    ).as_dict()
            ctx.run.artifact(f"costfun:{method}", {**entry, "rows": None, "rows_count": len(entry["rows"])})
            out.append(entry)
            if entry["problem"] and self.ignored:
                break  # no point asking for the third one
        return out, None

    async def _live_entry(self, ctx: JobContext, built: Built, live: str) -> dict[str, Any]:
        assert ctx.run is not None
        entry: dict[str, Any] = {
            "costfun": live,
            "live": True,
            "optim_status": None,
            "duration_ms": None,
            "problem": None,
            "generated_at": None,
            "rows": [],
            "totals": None,
        }
        if ctx.run.outcome != "ok":
            entry["problem"] = ctx.run.error or ctx.run.summary or "the live run did not produce a plan"
            entry["optim_status"] = ctx.run.outcome
            return entry
        plans = await self.c.extras["emhass"].plans(1)
        rows = plans[0]["plan"] if plans else []
        entry["optim_status"] = "ok"
        entry["generated_at"] = plans[0]["generated_at"] if plans else None
        entry["rows"] = rows
        entry["totals"] = plan_totals(
            rows,
            load_cost=built.result.payload.get("load_cost_forecast"),
            prod_price=built.result.payload.get("prod_price_forecast"),
        ).as_dict()
        return entry

    def describe(self, results: list[dict[str, Any]], built: Built) -> str:
        parts = []
        for r in results:
            totals = r.get("totals")
            label = LABEL[r["costfun"]] + (" (in use)" if r.get("live") else "")
            if totals:
                parts.append(f"{label} {totals['net_cost_eur']:+.2f} €")
            else:
                parts.append(f"{label}: no plan")
        return f"Net cost over {built.result.horizon * 15 / 60:g} h: " + " · ".join(parts)

    # --- storage ---------------------------------------------------------------------------------------------
    def _store(self, run_id: int | None, now: datetime, anchor: datetime, results: list[dict[str, Any]]) -> None:
        self.c.app_db.executemany(
            "INSERT INTO costfun_result (run_id, compared_at, anchor, costfun, live, optim_status, duration_ms, "
            "problem, totals_json, plan_gz) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    run_id,
                    iso(now),
                    iso(anchor),
                    r["costfun"],
                    1 if r.get("live") else 0,
                    r.get("optim_status"),
                    r.get("duration_ms"),
                    r.get("problem"),
                    json.dumps(r["totals"]) if r.get("totals") else None,
                    gzip.compress(json.dumps(r["rows"], default=str).encode()) if r.get("rows") else None,
                )
                for r in results
            ],
        )

    def latest(self) -> dict[str, Any] | None:
        """The newest comparison with its plans. Worker thread."""
        head = self.c.app_db.query_one(
            "SELECT run_id, compared_at, anchor FROM costfun_result ORDER BY id DESC LIMIT 1"
        )
        if head is None:
            return None
        rows = self.c.app_db.query(
            "SELECT * FROM costfun_result WHERE compared_at = ? AND anchor = ? ORDER BY live, id",
            (head["compared_at"], head["anchor"]),
        )
        results = []
        for r in rows:
            results.append(
                {
                    "costfun": r["costfun"],
                    "label": LABEL.get(r["costfun"], r["costfun"]),
                    "live": bool(r["live"]),
                    "optim_status": r["optim_status"],
                    "duration_ms": r["duration_ms"],
                    "problem": r["problem"],
                    "generated_at": None,
                    "totals": json.loads(r["totals_json"]) if r["totals_json"] else None,
                    "rows": json.loads(gzip.decompress(r["plan_gz"])) if r["plan_gz"] else [],
                }
            )
        return {
            "run_id": head["run_id"],
            "compared_at": head["compared_at"],
            "anchor": head["anchor"],
            "results": results,
        }

    def history(self, now: datetime, days: int = 7) -> list[dict[str, Any]]:
        """Net cost and EMHASS's objective per method for every comparison of the last `days`. Worker thread."""
        rows = self.c.app_db.query(
            "SELECT run_id, compared_at, anchor, costfun, totals_json FROM costfun_result WHERE compared_at >= ? "
            "ORDER BY id",
            (iso(now - timedelta(days=days)),),
        )
        points: dict[tuple[str, str], dict[str, Any]] = {}
        for r in rows:
            key = (r["compared_at"], r["anchor"])
            point = points.setdefault(
                key,
                {
                    "run_id": r["run_id"],
                    "compared_at": r["compared_at"],
                    "anchor": r["anchor"],
                    "net_cost_eur": {},
                    "emhass_objective": {},
                },
            )
            totals = json.loads(r["totals_json"]) if r["totals_json"] else None
            point["net_cost_eur"][r["costfun"]] = totals["net_cost_eur"] if totals else None
            point["emhass_objective"][r["costfun"]] = totals["emhass_objective"] if totals else None
        return list(points.values())

    def prune(self, now: datetime) -> int:
        cut = iso(now - timedelta(days=KEEP_DAYS))
        return self.c.app_db.execute("DELETE FROM costfun_result WHERE compared_at < ?", (cut,)).rowcount
