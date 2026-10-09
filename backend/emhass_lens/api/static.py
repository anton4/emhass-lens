"""Serves the built UI. index.html is revalidated on every load so an App update shows up right
away; the hashed files in assets/ can stay cached."""

from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class UIFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.headers.get("content-type", "").startswith("text/html"):
            response.headers["Cache-Control"] = "no-cache"
        return response
