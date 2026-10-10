from fastapi import APIRouter, Request

from emhass_lens.api.deps import ContainerDep, actor, write_block_reason
from emhass_lens.api.schemas import ComponentStatus, ProblemInfo, StatusInfo, UpdateInfo, VersionInfo

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/version")
async def version(c: ContainerDep) -> VersionInfo:
    """Used by the UI to notice an App update or restart and offer a reload."""
    return VersionInfo(version=c.boot.version, started_at=c.started_at_iso)


@router.get("/health/live")
async def live() -> dict[str, bool]:
    """Liveness for the Supervisor watchdog: answers as long as the event loop does."""
    return {"ok": True}


@router.get("/status")
async def status(c: ContainerDep, request: Request) -> StatusInfo:
    reason = write_block_reason(request)
    components: dict[str, ComponentStatus] = {
        "scheduler": ComponentStatus(
            status="ok" if c.scheduler.started else "warning",
            detail=None
            if c.scheduler.started
            else ("Paused: safe mode" if c.boot.safe_mode else "Not running: settings are invalid"),
        ),
    }
    for name, provider in c.extras.get("status_providers", {}).items():
        components[name] = provider()
    problems = [ProblemInfo(**p) for p in c.extras["problems"].active()] if "problems" in c.extras else []
    driver = c.extras["mpc"].driver() if "mpc" in c.extras else "none"
    update = c.extras["updates"].status() if "updates" in c.extras else None
    return StatusInfo(
        version=c.boot.version,
        started_at=c.started_at_iso,
        safe_mode=c.boot.safe_mode,
        under_supervisor=c.boot.under_supervisor,
        timezone=c.boot.tz,
        emhass_mode="off" if c.boot.safe_mode else c.settings.current.emhass.mode,
        settings_revision=c.settings.revision,
        settings_errors=c.settings.load_errors,
        scheduler_running=c.scheduler.started,
        writable=reason is None,
        write_block_reason=reason,
        actor=actor(request),
        components=components,
        problems=problems,
        driver=driver,
        update=UpdateInfo(**update) if update else None,
    )
