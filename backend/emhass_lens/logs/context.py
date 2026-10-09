"""Context carried into every log line: which run and which job produced it."""

from contextvars import ContextVar

run_id_var: ContextVar[int | None] = ContextVar("run_id", default=None)
job_var: ContextVar[str | None] = ContextVar("job", default=None)
