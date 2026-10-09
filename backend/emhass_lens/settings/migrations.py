"""Settings document migrations: pure dict -> dict functions, one per schema version step."""

from collections.abc import Callable
from typing import Any

from emhass_lens.settings.model import SCHEMA_VERSION

Doc = dict[str, Any]

# MIGRATIONS[n] upgrades a version-n document to version n+1.
MIGRATIONS: dict[int, Callable[[Doc], Doc]] = {}


def migrate(doc: Doc, from_version: int) -> tuple[Doc, int]:
    version = from_version
    while version < SCHEMA_VERSION:
        step = MIGRATIONS.get(version)
        if step is None:
            raise ValueError(f"no settings migration from version {version}")
        doc = step(doc)
        version += 1
    return doc, version
