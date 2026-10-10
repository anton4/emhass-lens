import asyncio
import json
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from emhass_lens.api.deps import ContainerDep
from emhass_lens.api.schemas import LogEntry

router = APIRouter(prefix="/api", tags=["logs"])

LEVEL_ORDER = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}


def _matches(entry: dict[str, Any], min_level: int, component: str | None, run_id: int | None, q: str | None) -> bool:
    if LEVEL_ORDER.get(entry["level"], 0) < min_level:
        return False
    if component and entry["component"] != component and not entry["component"].startswith(component + "."):
        return False
    if run_id is not None and entry.get("run_id") != run_id:
        return False
    return not (q and q.lower() not in entry["msg"].lower())


@router.get("/logs")
async def logs(
    c: ContainerDep,
    limit: Annotated[int, Query(ge=1, le=5000)] = 500,
    before_id: int | None = None,
    level: str = "DEBUG",
    component: str | None = None,
    run_id: int | None = None,
    q: str | None = None,
) -> list[LogEntry]:
    """Log history, newest last. Combines the database with the newest lines not yet flushed."""
    min_level = LEVEL_ORDER.get(level.upper(), 0)
    sql = (
        "SELECT id, ts, level, component, msg, run_id, job, exc FROM log WHERE 1=1"
        + (" AND id < :before" if before_id else "")
        + (" AND level IN (" + ",".join(f"'{lv}'" for lv, n in LEVEL_ORDER.items() if n >= min_level) + ")")
        + (" AND (component = :component OR component LIKE :component_prefix)" if component else "")
        + (" AND run_id = :run_id" if run_id is not None else "")
        + (" AND msg LIKE :q" if q else "")
        + " ORDER BY id DESC LIMIT :limit"
    )
    rows = await c.runs_db.aquery(
        sql,
        {
            "before": before_id,
            "component": component,
            "component_prefix": f"{component}.%",
            "run_id": run_id,
            "q": f"%{q}%",
            "limit": limit,
        },
    )
    rows.reverse()
    if before_id is None:
        newest = rows[-1]["id"] if rows else 0
        fresh = [
            e for e in c.logging.ring.tail(5000) if e["id"] > newest and _matches(e, min_level, component, run_id, q)
        ]
        rows = (rows + fresh)[-limit:]
    return [LogEntry(**row) for row in rows]


@router.get("/events")
async def events(c: ContainerDep, request: Request, topics: str | None = None) -> StreamingResponse:
    """Server-sent events: log, run.*, job.updated, settings.changed, ... (comma-separated prefixes)."""
    wanted = {t.strip() for t in topics.split(",") if t.strip()} if topics else None

    async def stream() -> AsyncIterator[str]:
        yield "retry: 3000\n\n"
        closing = asyncio.ensure_future(c.bus.closing.wait())
        try:
            async with c.bus.subscribe(wanted) as queue:
                while not c.bus.is_closing:
                    if await request.is_disconnected():
                        break
                    getter = asyncio.ensure_future(queue.get())
                    done, _pending = await asyncio.wait(
                        {getter, closing}, timeout=15, return_when=asyncio.FIRST_COMPLETED
                    )
                    if getter not in done:
                        getter.cancel()
                        if closing in done:
                            yield "event: shutdown\ndata: {}\n\n"  # the browser reconnects after `retry`
                            break
                        yield ": keep-alive\n\n"
                        continue
                    event = getter.result()
                    payload = json.dumps(event.data, ensure_ascii=False, default=str)
                    yield f"event: {event.topic}\ndata: {payload}\n\n"
        finally:
            closing.cancel()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
