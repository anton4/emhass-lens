"""EMHASS status and discovery, problems, Home Assistant entities, legacy import, take over / hand back."""

import time
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request

from emhass_lens.api.deps import ContainerDep, Writable, actor, write_block_reason
from emhass_lens.api.routes.runs import utc_bound
from emhass_lens.api.schemas import (
    ChargeModeRequest,
    ChargerStatus,
    DiffEntry,
    DriverRequest,
    DriverResult,
    EmhassStatusOut,
    EntityOption,
    InverterStatus,
    JobInfo,
    LegacyApplyRequest,
    LegacyPreview,
    MarketReconcileRequest,
    MarketSession,
    MarketStatus,
    MlRequest,
    MpcStatus,
    OutputsStatus,
    ProblemInfo,
    ProblemsResponse,
    RunStarted,
    SaveResponse,
    SetupChecklist,
    SetupStep,
    StorageOverview,
)
from emhass_lens.core.clock import iso
from emhass_lens.domain.entity_search import search_entities
from emhass_lens.services import driver, legacy_import, setup
from emhass_lens.settings.model import Settings
from emhass_lens.settings.store import SettingsInvalid, StaleRevision, _errors, deep_merge, diff_docs, mask_diff

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/storage")
async def storage(c: ContainerDep) -> StorageOverview:
    """Both databases: file sizes, pages in use and free, budgets, the biggest tables, the last cleanup and
    compaction, the newest Home Assistant backup that contains the App, and whether this is a restored copy."""
    svc = c.extras["storage"]
    data = await c.app_db.run(svc.overview)
    data["backup"] = await svc.backup_status()
    data["restored"] = svc.restored()
    return StorageOverview(**data)


@router.post("/storage/restore-ack", dependencies=[Writable])
async def storage_restore_ack(c: ContainerDep) -> StorageOverview:
    """Dismiss the "restored from a backup" note."""
    svc = c.extras["storage"]
    await c.app_db.run(svc.acknowledge_restore)
    data = await c.app_db.run(svc.overview)
    data["backup"] = await svc.backup_status()
    data["restored"] = svc.restored()
    return StorageOverview(**data)


@router.get("/emhass")
async def emhass_status(c: ContainerDep) -> EmhassStatusOut:
    status = c.extras["emhass"].status()
    status.pop("boot_ts", None)
    return EmhassStatusOut(**status, mpc=MpcStatus(**c.extras["mpc"].status()))


@router.post("/emhass/discover", dependencies=[Writable])
async def emhass_discover(c: ContainerDep) -> EmhassStatusOut:
    """Search for EMHASS again (only used when Settings → EMHASS → address is empty)."""
    await c.extras["emhass"].resolve()
    c.scheduler.run_now("emhass.health")
    status = c.extras["emhass"].status()
    status.pop("boot_ts", None)
    return EmhassStatusOut(**status, mpc=MpcStatus(**c.extras["mpc"].status()))


@router.post("/emhass/check", dependencies=[Writable], status_code=202)
async def emhass_check(c: ContainerDep) -> RunStarted:
    run_id = await c.scheduler.start_now("emhass.config_check")
    return RunStarted(job=JobInfo(**c.scheduler.jobs["emhass.config_check"].info()), run_id=run_id)


@router.get("/problems")
async def problems(c: ContainerDep) -> ProblemsResponse:
    svc = c.extras["problems"]
    return ProblemsResponse(active=[ProblemInfo(**p) for p in svc.active()], history=await svc.history())


ENTITY_CACHE_S = 30


@router.get("/ha/entities")
async def ha_entities(
    c: ContainerDep,
    request: Request,
    domain: Annotated[str | None, Query(description="Comma-separated domains, e.g. sensor,input_number")] = None,
    q: Annotated[str | None, Query(description="Words to find in the entity id or name; best matches first")] = None,
    limit: Annotated[int, Query(ge=1, le=2000)] = 500,
) -> list[EntityOption]:
    """Entities for the settings pickers (Home Assistant's states are re-read at most every 30 s). Only for
    requests that may change settings: the optional direct port has no login and mustn't expose every state."""
    reason = write_block_reason(request)
    if reason:
        raise HTTPException(403, reason)
    cache: dict[str, Any] = c.extras.setdefault("ha_entity_cache", {"at": None, "states": []})
    if cache["at"] is None or time.monotonic() - cache["at"] > ENTITY_CACHE_S:
        try:
            cache["states"] = await c.extras["ha"].get_states()
            cache["at"] = time.monotonic()
        except Exception as exc:
            raise HTTPException(503, f"Home Assistant: {exc}") from exc
    domains = {d.strip() for d in domain.split(",") if d.strip()} if domain else None
    return [_entity_option(state) for state in search_entities(cache["states"], domains, q or "", limit)]


def _entity_option(state: dict[str, Any]) -> EntityOption:
    attrs = state.get("attributes") or {}
    return EntityOption(
        entity_id=state["entity_id"],
        name=attrs.get("friendly_name"),
        state=state.get("state"),
        unit=attrs.get("unit_of_measurement"),
        device_class=attrs.get("device_class"),
    )


@router.get("/legacy/preview")
async def legacy_preview(c: ContainerDep) -> LegacyPreview:
    """What importing the HACS integration's settings would change."""
    try:
        result = await legacy_import.preview(c)
    except Exception as exc:
        return LegacyPreview(
            found=False, changes={}, notes=[f"Reading the integration failed: {exc}"], diff=[], errors=[]
        )
    current = c.settings.current.model_dump(mode="json")
    merged = deep_merge(current, result["changes"])
    try:
        new = Settings.model_validate(merged)
    except Exception as exc:
        return LegacyPreview(**result, diff=[], errors=_errors(exc))
    diff = mask_diff(diff_docs(current, new.model_dump(mode="json")))
    return LegacyPreview(**result, diff=[DiffEntry(**d) for d in diff], errors=[])


@router.post("/legacy/import", dependencies=[Writable], responses={409: {}, 422: {}})
async def legacy_apply(c: ContainerDep, request: Request, body: LegacyApplyRequest) -> SaveResponse:
    result = await legacy_import.preview(c)
    if not result["found"]:
        raise HTTPException(404, "The HACS integration wasn't found")
    try:
        saved = await c.settings.save(
            result["changes"],
            base_revision=body.base_revision,
            actor=actor(request),
            source="legacy_import",
            comment="Imported from the HACS integration",
        )
    except StaleRevision as exc:
        raise HTTPException(409, str(exc)) from exc
    except SettingsInvalid as exc:
        raise HTTPException(422, exc.errors) from exc
    return SaveResponse(revision=saved.revision, diff=[DiffEntry(**d) for d in saved.diff])


@router.post("/driver/take-over", dependencies=[Writable])
async def take_over(c: ContainerDep, request: Request, body: DriverRequest) -> DriverResult:
    """Turn the HACS integration's Auto MPC off and make EMHASS Lens drive EMHASS (live, Auto MPC on)."""
    try:
        return DriverResult(**await driver.take_over(c, actor(request), body.base_revision))
    except StaleRevision as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/driver/hand-back", dependencies=[Writable])
async def hand_back(c: ContainerDep, request: Request, body: DriverRequest) -> DriverResult:
    """Put EMHASS Lens in dry run and turn the HACS integration's Auto MPC back on."""
    return DriverResult(**await driver.hand_back(c, actor(request), body.base_revision))


@router.post("/ml/{action}", dependencies=[Writable], status_code=202)
async def ml_action(c: ContainerDep, action: str, body: MlRequest) -> RunStarted:
    job_id = {"fit": "ml.fit", "tune": "ml.tune", "predict": "ml.predict"}.get(action)
    if job_id is None:
        raise HTTPException(404, f"Unknown ML action {action}")
    params = {k: v for k, v in body.model_dump().items() if v is not None}
    run_id = await c.scheduler.start_now(job_id, params)
    return RunStarted(job=JobInfo(**c.scheduler.jobs[job_id].info()), run_id=run_id)


@router.get("/outputs")
async def outputs_status(c: ContainerDep) -> OutputsStatus:
    publish = c.extras["publish"]
    return OutputsStatus(
        **c.extras["outputs"].status(), last_event=publish.last_event, last_published_at=iso(publish.last_published_at)
    )


@router.get("/inverter")
async def inverter_status(c: ContainerDep) -> InverterStatus:
    """Inverter control (experimental): the last decision, the last comparison with the automation, agreement."""
    return InverterStatus(**await c.extras["inverter"].status())


@router.post("/inverter/decide", dependencies=[Writable], status_code=202)
async def inverter_decide(c: ContainerDep) -> RunStarted:
    """Decide now for the current slot (applies only in live mode)."""
    run_id = await c.scheduler.start_now("inverter.decide")
    return RunStarted(job=JobInfo(**c.scheduler.jobs["inverter.decide"].info()), run_id=run_id)


@router.get("/charger")
async def charger_status(c: ContainerDep) -> ChargerStatus:
    """EV charger control (experimental): the last decision, the last comparison with the automation, agreement."""
    return ChargerStatus(**await c.extras["charger"].status())


@router.post("/charger/decide", dependencies=[Writable], status_code=202)
async def charger_decide(c: ContainerDep) -> RunStarted:
    """Decide for the charger now (applies only in live mode)."""
    run_id = await c.scheduler.start_now("charger.decide", {"trigger": "manual"})
    return RunStarted(job=JobInfo(**c.scheduler.jobs["charger.decide"].info()), run_id=run_id)


@router.post("/charger/mode", dependencies=[Writable])
async def charger_mode(c: ContainerDep, request: Request, body: ChargeModeRequest) -> ChargerStatus:
    """Switch the charge-mode helper (Manual / EMHASS / Excess Solar) through Home Assistant."""
    try:
        await c.extras["charger"].set_charge_mode(body.option, actor(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ChargerStatus(**await c.extras["charger"].status())


@router.get("/market")
async def market_status(c: ContainerDep) -> MarketStatus:
    """Qilowatt market control (experimental): the session, the last decision and comparison, agreement, wear."""
    return MarketStatus(**await c.extras["market"].status())


@router.post("/market/reconcile", dependencies=[Writable], status_code=202)
async def market_reconcile(c: ContainerDep, body: MarketReconcileRequest | None = None) -> RunStarted:
    """Reconcile now (live: acts; force_end ends the open session whatever the command says)."""
    body = body or MarketReconcileRequest()
    params = {"trigger_entity": body.trigger_entity or "manual", "force_end": body.force_end}
    run_id = await c.scheduler.start_now("market.reconcile", params)
    return RunStarted(job=JobInfo(**c.scheduler.jobs["market.reconcile"].info()), run_id=run_id)


@router.get("/market/sessions")
async def market_sessions(
    c: ContainerDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    since: str | None = None,
    until: str | None = None,
) -> list[MarketSession]:
    """Market sessions newest first, optionally those started within [since, until)."""
    rows = await c.extras["market"].sessions(limit, utc_bound(since, "since"), utc_bound(until, "until"))
    return [MarketSession(**row) for row in rows]


@router.get("/setup")
async def setup_checklist(c: ContainerDep) -> SetupChecklist:
    """Getting started: each step of moving from the HACS integration to EMHASS Lens, and where it stands."""
    steps = [SetupStep(**s) for s in await setup.checklist(c)]
    required = [s for s in steps if not s.optional and s.state != "skipped"]
    return SetupChecklist(steps=steps, done=sum(1 for s in required if s.state == "done"), total=len(required))
