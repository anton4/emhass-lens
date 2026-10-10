import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from emhass_lens.api.deps import ContainerDep, Writable
from emhass_lens.api.schemas import LogEntry, RunDetail, RunSummary
from emhass_lens.core.clock import iso, parse_iso

router = APIRouter(prefix="/api/runs", tags=["runs"])


def utc_bound(value: str | None, name: str) -> str | None:
    """An ISO datetime from the query (any offset) as the UTC ISO text runs are stored with."""
    if value is None or value == "":
        return None
    try:
        parsed = parse_iso(value)
    except ValueError:
        parsed = None
    if parsed is None:
        raise HTTPException(400, f"{name} must be an ISO date-time with a time zone, e.g. 2026-10-10T00:00:00+03:00")
    return iso(parsed)


@router.get("")
async def list_runs(
    c: ContainerDep,
    job: str | None = None,
    outcome: str | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
    before: int | None = None,
    after: int | None = None,
    since: str | None = None,
    until: str | None = None,
    order: Literal["desc", "asc"] = "desc",
) -> list[RunSummary]:
    """Runs newest first (`order=asc`: oldest first), optionally for one job and outcome and started within
    [since, until). Page with `before` (the oldest id seen, newest first) or `after` (the newest id seen, oldest
    first)."""
    rows = await c.recorder.list(
        job,
        outcome,
        limit,
        before,
        after=after,
        since=utc_bound(since, "since"),
        until=utc_bound(until, "until"),
        ascending=order == "asc",
    )
    return [RunSummary(**row) for row in rows]


@router.get("/{run_id}")
async def get_run(c: ContainerDep, run_id: int) -> RunDetail:
    run = await c.recorder.get(run_id)
    if run is None:
        raise HTTPException(404, f"No run {run_id}")
    return RunDetail(**run)


@router.get("/{run_id}/artifacts/{kind}")
async def get_artifact(c: ContainerDep, run_id: int, kind: str) -> Any:
    try:
        return await c.recorder.artifact(run_id, kind)
    except KeyError:
        raise HTTPException(404, f"Run {run_id} has no {kind}") from None


@router.get("/{run_id}/logs")
async def run_logs(c: ContainerDep, run_id: int) -> list[LogEntry]:
    rows = await c.runs_db.aquery(
        "SELECT id, ts, level, component, msg, run_id, job, exc FROM log WHERE run_id = ? ORDER BY id", (run_id,)
    )
    stored = {row["id"] for row in rows}
    fresh = [e for e in c.logging.ring.tail(5000) if e.get("run_id") == run_id and e["id"] not in stored]
    return [LogEntry(**row) for row in rows + fresh]


@router.get("/{run_id}/bundle")
async def run_bundle(c: ContainerDep, run_id: int) -> Response:
    """Everything about one run in a single JSON file, for bug reports."""
    run = await c.recorder.get(run_id)
    if run is None:
        raise HTTPException(404, f"No run {run_id}")
    artifacts = {a["kind"]: await c.recorder.artifact(run_id, a["kind"]) for a in run["artifacts"]}
    logs = [entry.model_dump() for entry in await run_logs(c, run_id)]
    body = json.dumps(
        {"emhass_lens_version": c.boot.version, "run": run, "artifacts": artifacts, "logs": logs},
        ensure_ascii=False,
        indent=2,
        default=str,
    )
    return Response(
        body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="emhass-lens-run-{run_id}.json"'},
    )


@router.post("/{run_id}/pin", dependencies=[Writable])
async def pin_run(c: ContainerDep, run_id: int, pinned: bool = True) -> RunSummary:
    await c.recorder.set_pinned(run_id, pinned)
    run = await c.recorder.get(run_id)
    if run is None:
        raise HTTPException(404, f"No run {run_id}")
    return RunSummary(**run)
