"""EMHASS status and discovery, problems, Home Assistant entities, legacy import, take over / hand back."""

import time
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request

from emhass_lens.api.deps import ContainerDep, Writable, actor
from emhass_lens.api.schemas import (
    DiffEntry,
    DriverRequest,
    DriverResult,
    EmhassStatusOut,
    EntityOption,
    InverterStatus,
    JobInfo,
    LegacyApplyRequest,
    LegacyPreview,
    MlRequest,
    MpcStatus,
    OutputsStatus,
    ProblemInfo,
    ProblemsResponse,
    RunStarted,
    SaveResponse,
)
from emhass_lens.core.clock import iso
from emhass_lens.services import driver, legacy_import
from emhass_lens.settings.model import Settings
from emhass_lens.settings.store import SettingsInvalid, StaleRevision, _errors, deep_merge, diff_docs, mask_diff

router = APIRouter(prefix="/api", tags=["system"])


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


_ENTITY_CACHE: dict[str, Any] = {"at": 0.0, "states": []}


@router.get("/ha/entities")
async def ha_entities(
    c: ContainerDep,
    domain: Annotated[str | None, Query(description="Comma-separated domains, e.g. sensor,input_number")] = None,
    q: str | None = None,
    limit: Annotated[int, Query(ge=1, le=2000)] = 500,
) -> list[EntityOption]:
    """Entities for the settings pickers (cached for 30 s)."""
    ha = c.extras["ha"]
    if time.monotonic() - _ENTITY_CACHE["at"] > 30:
        try:
            _ENTITY_CACHE["states"] = await ha.get_states()
            _ENTITY_CACHE["at"] = time.monotonic()
        except Exception as exc:
            raise HTTPException(503, f"Home Assistant: {exc}") from exc
    domains = {d.strip() for d in domain.split(",")} if domain else None
    needle = (q or "").lower()
    out = []
    for state in _ENTITY_CACHE["states"]:
        entity_id = state.get("entity_id", "")
        if domains and entity_id.split(".", 1)[0] not in domains:
            continue
        attrs = state.get("attributes") or {}
        name = attrs.get("friendly_name")
        if needle and needle not in entity_id.lower() and needle not in str(name or "").lower():
            continue
        out.append(
            EntityOption(
                entity_id=entity_id,
                name=name,
                state=state.get("state"),
                unit=attrs.get("unit_of_measurement"),
                device_class=attrs.get("device_class"),
            )
        )
    out.sort(key=lambda e: e.entity_id)
    return out[:limit]


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
    return DriverResult(**await driver.take_over(c, actor(request), body.base_revision))


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
