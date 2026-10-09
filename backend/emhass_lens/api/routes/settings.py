from typing import Annotated, Any

import yaml
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import ValidationError

from emhass_lens.api.deps import ContainerDep, Writable, actor, write_block_reason
from emhass_lens.api.schemas import (
    DiffEntry,
    ImportPreview,
    ImportRequest,
    RevertRequest,
    Revision,
    SaveResponse,
    SettingsPatchRequest,
    SettingsResponse,
    SettingsSaveRequest,
)
from emhass_lens.settings.model import Settings, inlined_schema
from emhass_lens.settings.store import (
    SettingsInvalid,
    StaleRevision,
    _errors,
    diff_docs,
    mask_diff,
    unmask_secrets,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _conflict(exc: StaleRevision) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc), "revision": exc.current})


def _invalid(exc: SettingsInvalid) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": "Settings are not valid", "errors": exc.errors})


@router.get("")
async def get_settings(c: ContainerDep, request: Request) -> SettingsResponse:
    reason = write_block_reason(request)
    return SettingsResponse(
        revision=c.settings.revision,
        settings=Settings.model_validate(c.settings.masked()),
        errors=c.settings.load_errors,
        writable=reason is None,
        write_block_reason=reason,
    )


@router.get("/schema")
async def get_schema() -> dict[str, Any]:
    """JSON schema of the settings with UI hints (json_schema_extra.ui), $refs inlined."""
    return inlined_schema()


@router.put("", dependencies=[Writable], responses={409: {}, 422: {}})
async def put_settings(c: ContainerDep, request: Request, body: SettingsSaveRequest) -> SaveResponse:
    """Replace the whole settings document (the form sends everything it shows)."""
    try:
        result = await c.settings.save(
            body.settings,
            base_revision=body.base_revision,
            actor=actor(request),
            comment=body.comment,
            partial=False,
        )
    except StaleRevision as exc:
        return _conflict(exc)  # type: ignore[return-value]
    except SettingsInvalid as exc:
        return _invalid(exc)  # type: ignore[return-value]
    return SaveResponse(revision=result.revision, diff=[DiffEntry(**d) for d in result.diff])


@router.patch("", dependencies=[Writable], responses={409: {}, 422: {}})
async def patch_settings(c: ContainerDep, request: Request, body: SettingsPatchRequest) -> SaveResponse:
    """Change some fields; nested objects merge, lists and values replace."""
    try:
        result = await c.settings.save(
            body.changes,
            base_revision=body.base_revision,
            actor=actor(request),
            comment=body.comment,
        )
    except StaleRevision as exc:
        return _conflict(exc)  # type: ignore[return-value]
    except SettingsInvalid as exc:
        return _invalid(exc)  # type: ignore[return-value]
    return SaveResponse(revision=result.revision, diff=[DiffEntry(**d) for d in result.diff])


@router.get("/revisions")
async def revisions(
    c: ContainerDep, limit: Annotated[int, Query(ge=1, le=500)] = 50, before: int | None = None
) -> list[Revision]:
    return [Revision(**row) for row in await c.settings.revisions(limit, before)]


@router.get("/revisions/{revision}")
async def revision(c: ContainerDep, revision: int) -> dict[str, Any]:
    doc = await c.settings.revision_doc(revision)
    if doc is None:
        raise HTTPException(404, f"No revision {revision}")
    return doc


@router.post("/revert/{revision}", dependencies=[Writable], responses={409: {}, 422: {}})
async def revert(c: ContainerDep, request: Request, revision: int, body: RevertRequest) -> SaveResponse:
    try:
        result = await c.settings.revert(
            revision,
            base_revision=body.base_revision,
            actor=actor(request),
            comment=body.comment,
        )
    except KeyError:
        raise HTTPException(404, f"No revision {revision}") from None
    except StaleRevision as exc:
        return _conflict(exc)  # type: ignore[return-value]
    except SettingsInvalid as exc:
        return _invalid(exc)  # type: ignore[return-value]
    return SaveResponse(revision=result.revision, diff=[DiffEntry(**d) for d in result.diff])


@router.get("/export", response_class=PlainTextResponse)
async def export_yaml(c: ContainerDep) -> str:
    """The current settings as YAML (secrets masked; importing the file keeps the stored secrets)."""
    header = f"# EMHASS Lens settings, revision {c.settings.revision}\n"
    return header + yaml.safe_dump(c.settings.masked(), sort_keys=False, allow_unicode=True)


@router.post("/import", responses={409: {}})
async def import_yaml(c: ContainerDep, request: Request, body: ImportRequest) -> ImportPreview:
    """Preview (dry_run) or apply a YAML settings file. Missing keys fall back to defaults."""
    try:
        doc = yaml.safe_load(body.yaml) or {}
    except yaml.YAMLError as exc:
        return ImportPreview(diff=[], errors=[{"loc": "", "msg": f"YAML error: {exc}"}])
    if not isinstance(doc, dict):
        return ImportPreview(diff=[], errors=[{"loc": "", "msg": "The file must contain a settings mapping"}])
    current = c.settings.current.model_dump(mode="json")
    doc = unmask_secrets(doc, current)
    try:
        new = Settings.model_validate(doc)
    except ValidationError as exc:
        return ImportPreview(diff=[], errors=_errors(exc))
    diff = mask_diff(diff_docs(current, new.model_dump(mode="json")))
    if body.dry_run:
        return ImportPreview(diff=[DiffEntry(**d) for d in diff], errors=[])
    reason = write_block_reason(request)
    if reason:
        raise HTTPException(403, reason)
    try:
        result = await c.settings.save(
            doc,
            base_revision=body.base_revision,
            actor=actor(request),
            source="import",
            comment=body.comment or "Imported from YAML",
            partial=False,
        )
    except StaleRevision as exc:
        return _conflict(exc)  # type: ignore[return-value]
    except SettingsInvalid as exc:
        return ImportPreview(diff=[], errors=exc.errors)
    return ImportPreview(diff=[DiffEntry(**d) for d in result.diff], errors=[], revision=result.revision)
