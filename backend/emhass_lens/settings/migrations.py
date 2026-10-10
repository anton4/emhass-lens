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


def _v2_to_v3(doc: Doc) -> Doc:
    """0.3.2: retention moved from Logging to the new Storage section (size budgets, compaction)."""
    logging = doc.get("logging")
    if isinstance(logging, dict) and "retention" in logging:
        retention = logging.pop("retention")
        storage = doc.setdefault("storage", {})
        if isinstance(storage, dict) and isinstance(retention, dict):
            storage.setdefault("retention", retention)
    return doc


def _v3_to_v4(doc: Doc) -> Doc:
    """0.3.12: MPC runs at 11:00 into the quarter instead of 13:00, for more solver time; a changed time is kept."""
    mpc = (doc.get("emhass") or {}).get("mpc") if isinstance(doc.get("emhass"), dict) else None
    if isinstance(mpc, dict) and mpc.get("slot_offset_s") == 780:
        mpc["slot_offset_s"] = 660
    return doc


def _v4_to_v5(doc: Doc) -> Doc:
    """0.4.3: Inverter control's "Block export at or below" became EMHASS → MPC "No export at or below", which the
    plan uses too. The old default (0.03) was in force when the key was absent."""
    value: Any = 0.03
    inverter = doc.get("inverter")
    limits = inverter.get("limits") if isinstance(inverter, dict) else None
    if isinstance(limits, dict) and "low_export_price" in limits:
        value = limits.pop("low_export_price")
    emhass = doc.setdefault("emhass", {})
    if isinstance(emhass, dict):
        mpc = emhass.setdefault("mpc", {})
        if isinstance(mpc, dict):
            mpc.setdefault("no_export_at_or_below", value)
    return doc


# MIGRATIONS[n] upgrades a version-n document to version n+1.
MIGRATIONS: dict[int, Callable[[Doc], Doc]] = {1: _v1_to_v2, 2: _v2_to_v3, 3: _v3_to_v4, 4: _v4_to_v5}


def migrate(doc: Doc, from_version: int) -> tuple[Doc, int]:
    version = from_version
    while version < SCHEMA_VERSION:
        step = MIGRATIONS.get(version)
        if step is None:
            raise ValueError(f"no settings migration from version {version}")
        doc = step(doc)
        version += 1
    return doc, version
