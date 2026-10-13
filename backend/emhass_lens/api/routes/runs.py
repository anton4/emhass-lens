import asyncio
import io
import json
import zipfile
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from emhass_lens.api.deps import ContainerDep, Writable
from emhass_lens.api.schemas import LogEntry, RunDetail, RunSummary, RunTimeline, RunTimelineCell
from emhass_lens.core.clock import iso, parse_iso

router = APIRouter(prefix="/api/runs", tags=["runs"])

# The most runs one download of several takes: their ids must fit in a URL behind Ingress, and the zip is built in
# memory. The Runs page has the same limit.
MAX_DOWNLOAD = 200

RunIds = Annotated[list[int], Query(alias="id", description="A run id; repeat for several")]


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
    job: Annotated[list[str] | None, Query()] = None,
    outcome: Annotated[list[str] | None, Query()] = None,
    not_job: Annotated[list[str] | None, Query()] = None,
    not_outcome: Annotated[list[str] | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
    before: int | None = None,
    after: int | None = None,
    since: str | None = None,
    until: str | None = None,
    order: Literal["desc", "asc"] = "desc",
) -> list[RunSummary]:
    """Runs newest first (`order=asc`: oldest first), started within [since, until). Repeat `job` or `outcome` to
    keep any of several, and `not_job` or `not_outcome` to leave them out. Page with `before` (the oldest id seen,
    newest first) or `after` (the newest id seen, oldest first)."""
    rows = await c.recorder.list(
        job,
        outcome,
        limit,
        before,
        not_jobs=not_job or (),
        not_outcomes=not_outcome or (),
        after=after,
        since=utc_bound(since, "since"),
        until=utc_bound(until, "until"),
        ascending=order == "asc",
    )
    return [RunSummary(**row) for row in rows]


@router.get("/timeline")
async def run_timeline(
    c: ContainerDep,
    since: str,
    until: str,
    bucket_s: Annotated[int, Query(ge=60, le=86400)] = 900,
) -> RunTimeline:
    """Run counts per job, outcome and `bucket_s`-second bucket of [since, until), for the Runs page timeline: a
    day can hold more runs than one page of the list."""
    start = utc_bound(since, "since")
    end = utc_bound(until, "until")
    if start is None or end is None:
        raise HTTPException(400, "since and until are required")
    first, last = parse_iso(start), parse_iso(end)
    span = (last - first).total_seconds() if first and last else 0
    if span <= 0:
        raise HTTPException(400, "until must be after since")
    if span / bucket_s > 2000:
        raise HTTPException(400, "Too many buckets: pick a larger bucket_s or a shorter range")
    cells = await c.recorder.histogram(start, end, bucket_s)
    return RunTimeline(since=start, until=end, bucket_s=bucket_s, cells=[RunTimelineCell(**cell) for cell in cells])


def picked(ids: list[int]) -> list[int]:
    """The runs of a download of several, oldest first and each once."""
    unique = sorted(set(ids))
    if len(unique) > MAX_DOWNLOAD:
        raise HTTPException(400, f"At most {MAX_DOWNLOAD} runs per download")
    return unique


def attachment(found: list[int], ext: str) -> dict[str, str]:
    name = f"emhass-lens-run-{found[0]}" if len(found) == 1 else f"emhass-lens-runs-{found[0]}-{found[-1]}"
    return {"Content-Disposition": f'attachment; filename="{name}.{ext}"'}


def dump(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


def log_line(entry: LogEntry) -> str:
    """A log line as the Logs page downloads it."""
    run = f" run={entry.run_id}" if entry.run_id else ""
    exc = f"\n{entry.exc}" if entry.exc else ""
    return f"{entry.ts} {entry.level:<7} [{entry.component}]{run} {entry.msg}{exc}"


def run_log_section(run: dict[str, Any], entries: list[LogEntry], artifacts: dict[str, Any]) -> str:
    """One run in the .log of several: a header naming the run, its summary, its log lines, then each artifact as
    JSON under a `## <kind>` line. Most market reconciles write no log lines; what they did is in the artifacts."""
    took = f" · took {run['duration_ms']} ms" if run.get("duration_ms") is not None else ""
    header = f"# Run {run['id']} · {run['job']} · started {run['started_at']}{took} · {run['outcome']}"
    summary = [f"# {line}" for line in (run.get("summary") or "").splitlines()]
    lines = [log_line(entry) for entry in entries] or ["(no log lines kept for this run)"]
    shown = [f"## {kind}\n{dump(data)}" for kind, data in artifacts.items()]
    return "\n".join([header, *summary, *lines, *shown])


@router.get("/bundles")
async def runs_bundles(c: ContainerDep, ids: RunIds) -> Response:
    """The bundles of several runs in one zip, an emhass-lens-run-<id>.json each. Runs already removed are left
    out."""
    buffer = io.BytesIO()
    found: list[int] = []
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:

        def write(name: str, bundle: dict[str, Any]) -> None:
            archive.writestr(name, dump(bundle))

        for run_id in picked(ids):
            bundle = await bundle_of(c, run_id)
            if bundle is None:
                continue
            # Off the event loop: a zip of many MPC runs takes a while to compress
            await asyncio.to_thread(write, f"emhass-lens-run-{run_id}.json", bundle)
            found.append(run_id)
    if not found:
        raise HTTPException(404, "None of these runs is kept any more")
    return Response(buffer.getvalue(), media_type="application/zip", headers=attachment(found, "zip"))


@router.get("/logs")
async def runs_logs_text(c: ContainerDep, ids: RunIds) -> Response:
    """Several runs as one text file, oldest run first: each under a header line and its summary, with its log
    lines and then its artifacts as JSON. Runs already removed are left out."""
    parts: list[str] = []
    found: list[int] = []
    for run_id in picked(ids):
        run = await c.recorder.get(run_id)
        if run is None:
            continue
        entries, artifacts = await run_logs(c, run_id), await artifacts_of(c, run)
        # Off the event loop: the artifacts of many MPC runs take a while to format
        parts.append(await asyncio.to_thread(run_log_section, run, entries, artifacts))
        found.append(run_id)
    if not found:
        raise HTTPException(404, "None of these runs is kept any more")
    return Response("\n\n".join(parts) + "\n", media_type="text/plain", headers=attachment(found, "log"))


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


async def artifacts_of(c: ContainerDep, run: dict[str, Any]) -> dict[str, Any]:
    """A run's artifacts by kind, the newest of each kind."""
    return {a["kind"]: await c.recorder.artifact(run["id"], a["kind"]) for a in run["artifacts"]}


async def bundle_of(c: ContainerDep, run_id: int) -> dict[str, Any] | None:
    """Everything about one run: the run, its artifacts and its log lines. None when there is no such run."""
    run = await c.recorder.get(run_id)
    if run is None:
        return None
    artifacts = await artifacts_of(c, run)
    logs = [entry.model_dump() for entry in await run_logs(c, run_id)]
    return {"emhass_lens_version": c.boot.version, "run": run, "artifacts": artifacts, "logs": logs}


@router.get("/{run_id}/bundle")
async def run_bundle(c: ContainerDep, run_id: int) -> Response:
    """Everything about one run in a single JSON file, for bug reports."""
    bundle = await bundle_of(c, run_id)
    if bundle is None:
        raise HTTPException(404, f"No run {run_id}")
    return Response(dump(bundle), media_type="application/json", headers=attachment([run_id], "json"))


@router.post("/{run_id}/pin", dependencies=[Writable])
async def pin_run(c: ContainerDep, run_id: int, pinned: bool = True) -> RunSummary:
    await c.recorder.set_pinned(run_id, pinned)
    run = await c.recorder.get(run_id)
    if run is None:
        raise HTTPException(404, f"No run {run_id}")
    return RunSummary(**run)
