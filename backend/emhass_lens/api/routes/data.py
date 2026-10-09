"""Prices, inputs, the EMHASS plan and an on-demand MPC preview."""

from dataclasses import asdict
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Query

from emhass_lens.api.deps import ContainerDep
from emhass_lens.api.schemas import (
    InputsResponse,
    MpcPreview,
    PlanResponse,
    PlanSnapshotOut,
    PriceSlotOut,
    PricesResponse,
)
from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.mpc.anchor import anchor_slot
from emhass_lens.domain.mpc.payload import build
from emhass_lens.domain.mpc.validate import validate
from emhass_lens.services.inputs import describe
from emhass_lens.services.prices import area_tz, utc_day_start

router = APIRouter(prefix="/api", tags=["data"])


def _slot_out(p: Any) -> PriceSlotOut:
    data = asdict(p)
    data["start"], data["end"] = iso(p.start), iso(p.end)
    return PriceSlotOut(**data)


@router.get("/prices")
async def prices(c: ContainerDep, days_back: Annotated[int, Query(ge=0, le=60)] = 1) -> PricesResponse:
    """Priced 15-minute slots from local midnight `days_back` days ago to the end of the forecast."""
    settings = c.settings.current
    tz = area_tz(settings)
    now = c.clock.now()
    start = utc_day_start((now.astimezone(tz) - timedelta(days=days_back)).date(), tz)
    svc = c.extras["prices"]
    forecast = c.extras["forecasts"].current()
    stitched = await c.app_db.run(svc.stitched, start, forecast)
    slots = await c.app_db.run(svc.priced, start, forecast)
    return PricesResponse(
        timezone=str(tz),
        now=iso(now) or "",
        package=settings.prices.tariff.package,
        slots=[_slot_out(p) for p in slots],
        actual_end=iso(stitched.actual_end),
        forecast_until=iso(stitched.forecast_until),
        gaps=[[iso(a) or "", iso(b) or ""] for a, b in stitched.gaps],
        nordpool=svc.status(),
        forecast=c.extras["forecasts"].status(),
    )


@router.get("/inputs")
async def inputs(c: ContainerDep) -> InputsResponse:
    """What an MPC run would use right now, with where every value comes from."""
    now = c.clock.now()
    snapshot = await c.app_db.run(c.extras["inputs"].snapshot, now)
    return InputsResponse(
        snapshot=describe(snapshot),
        pv=c.extras["pv"].status(),
        forecast=c.extras["forecasts"].status(),
        home_assistant=c.extras["ha"].status(),
        mpc=c.extras["mpc"].status(),
    )


@router.post("/mpc/preview")
async def mpc_preview(c: ContainerDep) -> MpcPreview:
    """Build and check the MPC payload as if a run started now. Nothing is sent."""
    settings = c.settings.current
    emhass = c.extras["emhass"]
    now = c.clock.now()
    snapshot = await c.app_db.run(c.extras["inputs"].snapshot, now)
    rounding = emhass.method_ts_round()
    anchor = anchor_slot(now, rounding)
    result = build(snapshot, anchor, slot_floor(now), settings)
    issues = validate(result, snapshot, settings)
    return MpcPreview(
        built_at=iso(now) or "",
        anchor=iso(anchor) or "",
        rounding=rounding,
        mode=c.extras["mpc"].mode,
        payload=result.payload,
        explain=result.explain,
        validation=[i.as_dict() for i in issues],
        inputs=describe(snapshot),
        derived=result.derived.__dict__,
    )


def _snapshot_out(row: dict[str, Any] | None) -> PlanSnapshotOut | None:
    if row is None:
        return None
    return PlanSnapshotOut(
        generated_at=row["generated_at"],
        fetched_at=row["fetched_at"],
        driver=row["driver"],
        run_id=row.get("run_id"),
        last_run=row.get("last_run"),
        rows=row["plan"],
    )


@router.get("/plan")
async def plan(c: ContainerDep) -> PlanResponse:
    """The newest EMHASS plan (and the one before it), with prices on the same slots."""
    emhass = c.extras["emhass"]
    snapshots = await emhass.plans(2)
    current = snapshots[0] if snapshots else None
    previous = snapshots[1] if len(snapshots) > 1 else None
    now = c.clock.now()
    current_row = None
    columns: list[str] = []
    price_rows: list[dict[str, Any]] = []
    if current and current["plan"]:
        columns = [k for k in current["plan"][0] if k != "timestamp"]
        slot = slot_floor(now)
        for row in current["plan"]:
            ts = parse_iso(str(row.get("timestamp")))
            if ts == slot:
                current_row = row
        first = parse_iso(str(current["plan"][0].get("timestamp")))
        if first is not None:
            priced = await c.app_db.run(c.extras["prices"].priced, first, c.extras["forecasts"].current())
            price_rows = [
                {
                    "start": iso(p.start),
                    "import_price": p.import_price,
                    "export_price": p.export_price,
                    "origin": p.origin,
                }
                for p in priced
            ]
    return PlanResponse(
        available=current is not None,
        current=_snapshot_out(current),
        previous=_snapshot_out(previous),
        current_row=current_row,
        columns=columns,
        prices=price_rows,
        driver=c.extras["mpc"].driver(),
        emhass_url=emhass.url,
    )
