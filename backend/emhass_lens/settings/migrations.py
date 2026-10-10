"""Settings document migrations: pure dict -> dict functions, one per schema version step."""

from collections.abc import Callable
from typing import Any

from emhass_lens.settings.model import SCHEMA_VERSION

Doc = dict[str, Any]


def _drop(doc: Doc, *path: str) -> Doc:
    node: Any = doc
    for key in path[:-1]:
        node = node.get(key) if isinstance(node, dict) else None
        if node is None:
            return doc
    if isinstance(node, dict):
        node.pop(path[-1], None)
    return doc


def _v1_to_v2(doc: Doc) -> Doc:
    """0.3.1: the Fusebox sell power helper (a manual export override from the Qilowatt automation) is gone."""
    return _drop(doc, "market", "entities", "fusebox_sell_helper")


# MIGRATIONS[n] upgrades a version-n document to version n+1.
MIGRATIONS: dict[int, Callable[[Doc], Doc]] = {1: _v1_to_v2}


def migrate(doc: Doc, from_version: int) -> tuple[Doc, int]:
    version = from_version
    while version < SCHEMA_VERSION:
        step = MIGRATIONS.get(version)
        if step is None:
            raise ValueError(f"no settings migration from version {version}")
        doc = step(doc)
        version += 1
    return doc, version
