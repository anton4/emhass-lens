"""Settings persistence: every save is a new revision with its diff, actor and comment.

The current settings are the newest revision. Saves use optimistic concurrency (base_revision),
so two open browser tabs can't silently overwrite each other. Subscribers are told which paths
changed and react only to those (re-time a job, re-apply log levels, ...).
"""

import asyncio
import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from emhass_lens.core.bus import EventBus
from emhass_lens.core.clock import Clock, iso
from emhass_lens.core.redact import MASK, redactor
from emhass_lens.db.conn import Database
from emhass_lens.settings.migrations import migrate
from emhass_lens.settings.model import SCHEMA_VERSION, Settings, secret_paths

log = logging.getLogger("emhass_lens.settings")

Doc = dict[str, Any]
Listener = Callable[[Settings, Settings, list[str]], Awaitable[None] | None]


class StaleRevision(Exception):
    def __init__(self, current: int) -> None:
        super().__init__(f"settings changed meanwhile (now revision {current})")
        self.current = current


class SettingsInvalid(Exception):
    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("; ".join(f"{e['loc']}: {e['msg']}" for e in errors))
        self.errors = errors


@dataclass
class SaveResult:
    revision: int
    diff: list[dict[str, Any]]
    settings: Settings


@dataclass
class _Subscription:
    prefixes: tuple[str, ...]
    callback: Listener


@dataclass
class SettingsStore:
    db: Database
    bus: EventBus
    clock: Clock
    current: Settings = field(default_factory=lambda: Settings())
    revision: int = 0
    load_errors: list[dict[str, str]] = field(default_factory=list)
    _subscriptions: list[_Subscription] = field(default_factory=list)
    _save_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    # --- loading ------------------------------------------------------------------------------------
    def load(self) -> Settings:
        """Read the newest revision at startup, migrating it if the schema moved on."""
        row = self.db.query_one("SELECT id, schema_version, doc_json FROM settings_revision ORDER BY id DESC LIMIT 1")
        if row is None:
            self.current = Settings()
            self.revision = self._insert(self.current, [], source="default", actor="system", comment="Defaults")
            log.info("No settings yet: stored the defaults as revision %d", self.revision)
            self._update_secrets()
            return self.current

        doc = json.loads(row["doc_json"])
        version = row["schema_version"]
        try:
            if version < SCHEMA_VERSION:
                migrated, _ = migrate(doc, version)
                settings = Settings.model_validate(migrated)
                diff = diff_docs(doc, settings.model_dump(mode="json"))
                self.revision = self._insert(
                    settings,
                    diff,
                    source="migration",
                    actor="system",
                    comment=f"Schema {version} → {SCHEMA_VERSION}",
                )
                log.info("Migrated settings from schema %d to %d", version, SCHEMA_VERSION)
            else:
                settings = Settings.model_validate(doc)
                self.revision = row["id"]
            self.current = settings
            self.load_errors = []
        except (ValidationError, ValueError) as exc:
            self.load_errors = _errors(exc)
            self.revision = row["id"]
            self.current = Settings()
            log.error(
                "Stored settings (revision %d) are invalid; running on defaults with jobs paused: %s",
                row["id"],
                "; ".join(f"{e['loc']}: {e['msg']}" for e in self.load_errors),
            )
        self._update_secrets()
        return self.current

    # --- reading ---------------------------------------------------------------------------------------
    def masked(self, settings: Settings | None = None) -> Doc:
        return mask_secrets((settings or self.current).model_dump(mode="json"))

    async def revisions(self, limit: int = 50, before: int | None = None) -> list[dict[str, Any]]:
        rows = await self.db.aquery(
            "SELECT id, created_at, actor, source, schema_version, diff_json, comment FROM settings_revision "
            "WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
            (before, before, limit),
        )
        for row in rows:
            row["diff"] = mask_diff(json.loads(row.pop("diff_json")))
        return rows

    async def revision_doc(self, revision: int) -> Doc | None:
        row = await self.db.aquery_one("SELECT doc_json FROM settings_revision WHERE id = ?", (revision,))
        return mask_secrets(json.loads(row["doc_json"])) if row else None

    # --- writing ---------------------------------------------------------------------------------------
    async def save(
        self,
        changes: Doc,
        *,
        base_revision: int | None,
        actor: str | None,
        source: str = "ui",
        comment: str | None = None,
        partial: bool = True,
    ) -> SaveResult:
        """Validate and store a new revision. partial=True deep-merges `changes` into the current
        settings; partial=False treats `changes` as the whole document (missing keys -> defaults)."""
        async with self._save_lock:
            if base_revision is not None and base_revision != self.revision:
                raise StaleRevision(self.revision)
            current_doc = self.current.model_dump(mode="json")
            changes = unmask_secrets(changes, current_doc)
            new_doc = deep_merge(current_doc, changes) if partial else changes
            try:
                new = Settings.model_validate(new_doc)
            except ValidationError as exc:
                raise SettingsInvalid(_errors(exc)) from exc
            diff = diff_docs(current_doc, new.model_dump(mode="json"))
            if not diff:
                return SaveResult(self.revision, [], self.current)
            revision = await self.db.run(self._insert, new, diff, source, actor, comment)
            old, self.current, self.revision = self.current, new, revision
            self.load_errors = []
            self._update_secrets()
        log.info(
            "Settings revision %d saved by %s (%s): %s",
            revision,
            actor or "unknown",
            source,
            ", ".join(d["path"] for d in diff),
        )
        self.bus.publish("settings.changed", {"revision": revision, "paths": [d["path"] for d in diff]})
        await self._notify(old, new, [d["path"] for d in diff])
        return SaveResult(revision, mask_diff(diff), new)

    async def revert(
        self, revision: int, *, base_revision: int | None, actor: str | None, comment: str | None = None
    ) -> SaveResult:
        row = await self.db.aquery_one(
            "SELECT schema_version, doc_json FROM settings_revision WHERE id = ?", (revision,)
        )
        if row is None:
            raise KeyError(revision)
        doc, _ = migrate(json.loads(row["doc_json"]), row["schema_version"])
        return await self.save(
            doc,
            base_revision=base_revision,
            actor=actor,
            source="revert",
            partial=False,
            comment=comment or f"Revert to revision {revision}",
        )

    def _insert(
        self, settings: Settings, diff: list[dict[str, Any]], source: str, actor: str | None, comment: str | None
    ) -> int:
        cursor = self.db.execute(
            "INSERT INTO settings_revision (created_at, actor, source, schema_version, doc_json, diff_json, "
            "comment) VALUES (?,?,?,?,?,?,?)",
            (
                iso(self.clock.now()),
                actor,
                source,
                SCHEMA_VERSION,
                json.dumps(settings.model_dump(mode="json"), ensure_ascii=False),
                json.dumps(diff, ensure_ascii=False),
                comment,
            ),
        )
        return int(cursor.lastrowid or 0)

    # --- change notifications ------------------------------------------------------------------------
    def subscribe(self, prefixes: str | tuple[str, ...], callback: Listener) -> None:
        """Call `callback(old, new, changed_paths)` when a path under one of the prefixes changes.
        An empty prefix matches everything."""
        if isinstance(prefixes, str):
            prefixes = (prefixes,)
        self._subscriptions.append(_Subscription(prefixes, callback))

    async def _notify(self, old: Settings, new: Settings, paths: list[str]) -> None:
        for sub in self._subscriptions:
            matched = [p for p in paths if any(_under(p, prefix) for prefix in sub.prefixes)]
            if not matched:
                continue
            try:
                result = sub.callback(old, new, matched)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                log.exception("Applying a settings change failed (%s)", ", ".join(matched))

    def _update_secrets(self) -> None:
        doc = self.current.model_dump(mode="json")
        redactor.set_secrets([_get(doc, path) for path in secret_paths()])


# --- helpers -----------------------------------------------------------------------------------------


def _under(path: str, prefix: str) -> bool:
    return not prefix or path == prefix or path.startswith(prefix + ".")


def _errors(exc: Exception) -> list[dict[str, str]]:
    if isinstance(exc, ValidationError):
        return [
            {"loc": ".".join(str(part) for part in err["loc"]), "msg": err["msg"].removeprefix("Value error, ")}
            for err in exc.errors()
        ]
    return [{"loc": "", "msg": str(exc)}]


def deep_merge(base: Doc, changes: Doc) -> Doc:
    """Merge `changes` into a copy of `base`. Nested dicts merge; everything else (lists, None) replaces."""
    result = dict(base)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def diff_docs(old: Any, new: Any, path: str = "") -> list[dict[str, Any]]:
    """Leaf-level differences between two documents; lists compare as whole values."""
    if isinstance(old, dict) and isinstance(new, dict):
        out: list[dict[str, Any]] = []
        for key in sorted(set(old) | set(new), key=lambda k: (list(old) + list(new)).index(k)):
            sub = f"{path}.{key}" if path else key
            if key not in old:
                out.append({"path": sub, "old": None, "new": new[key]})
            elif key not in new:
                out.append({"path": sub, "old": old[key], "new": None})
            else:
                out.extend(diff_docs(old[key], new[key], sub))
        return out
    return [] if old == new else [{"path": path, "old": old, "new": new}]


def _get(doc: Doc, path: tuple[str, ...]) -> Any:
    node: Any = doc
    for part in path:
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _set(doc: Doc, path: tuple[str, ...], value: Any) -> None:
    node = doc
    for part in path[:-1]:
        node = node.setdefault(part, {})
    node[path[-1]] = value


def mask_secrets(doc: Doc) -> Doc:
    doc = json.loads(json.dumps(doc))
    for path in secret_paths():
        if _get(doc, path):
            _set(doc, path, MASK)
    return doc


def unmask_secrets(changes: Doc, current: Doc) -> Doc:
    """A secret sent back as the mask keeps its stored value."""
    changes = json.loads(json.dumps(changes))
    for path in secret_paths():
        if _get(changes, path) == MASK:
            _set(changes, path, _get(current, path))
    return changes


def mask_diff(diff: list[dict[str, Any]]) -> list[dict[str, Any]]:
    secret = {".".join(p) for p in secret_paths()}
    return [
        {**d, "old": MASK if d["old"] else d["old"], "new": MASK if d["new"] else d["new"]}
        if d["path"] in secret
        else d
        for d in diff
    ]
