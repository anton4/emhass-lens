from fastapi import APIRouter, HTTPException

from emhass_lens.api.deps import ContainerDep, Writable
from emhass_lens.api.schemas import JobInfo

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _job(c: ContainerDep, job_id: str):
    job = c.scheduler.jobs.get(job_id)
    if job is None:
        raise HTTPException(404, f"No job {job_id}")
    return job


@router.get("")
async def list_jobs(c: ContainerDep) -> list[JobInfo]:
    return [JobInfo(**info) for info in c.scheduler.info()]


@router.post("/{job_id}/run", dependencies=[Writable], status_code=202)
async def run_job(c: ContainerDep, job_id: str) -> JobInfo:
    job = _job(c, job_id)
    c.scheduler.run_now(job.id)
    return JobInfo(**job.info())


@router.post("/{job_id}/pause", dependencies=[Writable])
async def pause_job(c: ContainerDep, job_id: str) -> JobInfo:
    job = await c.scheduler.set_paused(_job(c, job_id).id, True)
    return JobInfo(**job.info())


@router.post("/{job_id}/resume", dependencies=[Writable])
async def resume_job(c: ContainerDep, job_id: str) -> JobInfo:
    job = await c.scheduler.set_paused(_job(c, job_id).id, False)
    return JobInfo(**job.info())
