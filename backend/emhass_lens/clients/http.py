"""Shared httpx clients with request logging (secrets masked) and timing."""

import logging
import time
from typing import Any

import httpx

from emhass_lens.core.redact import redactor

log = logging.getLogger("emhass_lens.http")

USER_AGENT = "EMHASS-Lens (+https://github.com/anton4/emhass-lens)"


def make_client(
    name: str, *, base_url: str = "", headers: dict[str, str] | None = None, timeout: float = 15.0, **kwargs: Any
) -> httpx.AsyncClient:
    component = logging.getLogger(f"emhass_lens.http.{name}")

    async def on_request(request: httpx.Request) -> None:
        request.extensions["started"] = time.monotonic()

    async def on_response(response: httpx.Response) -> None:
        started = response.request.extensions.get("started")
        ms = int((time.monotonic() - started) * 1000) if started else -1
        component.debug(
            "%s %s → %s in %d ms",
            response.request.method,
            redactor.text(str(response.request.url)),
            response.status_code,
            ms,
        )

    return httpx.AsyncClient(
        base_url=base_url,
        headers={"User-Agent": USER_AGENT, **(headers or {})},
        timeout=httpx.Timeout(timeout, connect=min(10.0, timeout)),
        event_hooks={"request": [on_request], "response": [on_response]},
        follow_redirects=True,
        **kwargs,
    )


def describe_error(exc: BaseException) -> str:
    """Short, user-facing text for a request failure."""
    if isinstance(exc, httpx.TimeoutException):
        return f"timed out ({type(exc).__name__})"
    if isinstance(exc, httpx.ConnectError):
        return f"cannot connect: {exc}" if str(exc) else "cannot connect"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}"
    return f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
