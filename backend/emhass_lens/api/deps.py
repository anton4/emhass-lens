"""Request helpers: the container, who is asking, and whether they may change things."""

from typing import Annotated

from fastapi import Depends, HTTPException, Request

from emhass_lens.container import Container


def get_container(request: Request) -> Container:
    return request.app.state.container


ContainerDep = Annotated[Container, Depends(get_container)]


def write_block_reason(request: Request) -> str | None:
    """Why this request may not change anything, or None if it may.

    As a Home Assistant App only requests through Ingress (HA login) may write; the optional
    direct port has no authentication and stays read-only. Standalone installs are writable
    unless EMHASS_LENS_READ_ONLY is set.
    """
    c = get_container(request)
    if c.boot.under_supervisor:
        if request.client is None or request.client.host != c.boot.ingress_ip:
            return "Open EMHASS Lens from the Home Assistant sidebar to make changes."
        return None
    if c.boot.standalone_read_only:
        return "This standalone install is read-only (EMHASS_LENS_READ_ONLY)."
    return None


def require_writable(request: Request) -> None:
    reason = write_block_reason(request)
    if reason:
        raise HTTPException(status_code=403, detail=reason)


Writable = Depends(require_writable)


def actor(request: Request) -> str:
    """The Home Assistant user behind an Ingress request (headers set by the Supervisor)."""
    for header in ("x-remote-user-display-name", "x-remote-user-name"):
        value = request.headers.get(header)
        if value:
            return value
    c = get_container(request)
    return "standalone user" if not c.boot.under_supervisor else "unknown"
