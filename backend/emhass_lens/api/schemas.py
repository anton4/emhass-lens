"""Response models: they document the API and generate the frontend's TypeScript types."""

from typing import Any

from pydantic import BaseModel

from emhass_lens.settings.model import Settings


class VersionInfo(BaseModel):
    version: str
    started_at: str


class ComponentStatus(BaseModel):
    status: str  # ok | warning | error | unknown | disabled
    detail: str | None = None


class StatusInfo(BaseModel):
    version: str
    started_at: str
    safe_mode: bool
    under_supervisor: bool
    timezone: str
    emhass_mode: str
    settings_revision: int
    settings_errors: list[dict[str, str]]
    scheduler_running: bool
    writable: bool
    write_block_reason: str | None
    actor: str
    components: dict[str, ComponentStatus]
    problems: list[dict[str, Any]]


class LogEntry(BaseModel):
    id: int
    ts: str
    level: str
    component: str
    msg: str
    run_id: int | None = None
    job: str | None = None
    exc: str | None = None


class JobInfo(BaseModel):
    id: str
    title: str
    description: str
    trigger: str
    paused: bool
    running: bool
    next_run: str | None
    last_started: str | None
    last_finished: str | None
    last_outcome: str | None
    last_run_id: int | None
    grace_s: int


class RunSummary(BaseModel):
    id: int
    job: str
    trigger: str
    mode: str | None = None
    scheduled_at: str | None = None
    started_at: str
    finished_at: str | None = None
    duration_ms: int | None = None
    outcome: str
    summary: str | None = None
    error: str | None = None
    settings_rev: int | None = None
    pinned: int = 0


class ArtifactInfo(BaseModel):
    id: int
    kind: str
    created_at: str
    size: int


class RunDetail(RunSummary):
    artifacts: list[ArtifactInfo]


class SettingsResponse(BaseModel):
    revision: int
    settings: Settings
    errors: list[dict[str, str]]
    writable: bool
    write_block_reason: str | None


class DiffEntry(BaseModel):
    path: str
    old: Any = None
    new: Any = None


class SaveResponse(BaseModel):
    revision: int
    diff: list[DiffEntry]


class Revision(BaseModel):
    id: int
    created_at: str
    actor: str | None
    source: str
    schema_version: int
    comment: str | None
    diff: list[DiffEntry]


class SettingsSaveRequest(BaseModel):
    base_revision: int | None = None
    settings: dict[str, Any]
    comment: str | None = None


class SettingsPatchRequest(BaseModel):
    base_revision: int | None = None
    changes: dict[str, Any]
    comment: str | None = None


class RevertRequest(BaseModel):
    base_revision: int | None = None
    comment: str | None = None


class ImportRequest(BaseModel):
    base_revision: int | None = None
    yaml: str
    comment: str | None = None
    dry_run: bool = True


class ImportPreview(BaseModel):
    diff: list[DiffEntry]
    errors: list[dict[str, str]]
    revision: int | None = None
