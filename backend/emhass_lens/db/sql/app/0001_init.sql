-- Settings: every saved version is kept; the newest row is the current settings.
CREATE TABLE settings_revision (
    id             INTEGER PRIMARY KEY,
    created_at     TEXT    NOT NULL,
    actor          TEXT,
    source         TEXT    NOT NULL,   -- ui | import | migration | revert | legacy_import | default
    schema_version INTEGER NOT NULL,
    doc_json       TEXT    NOT NULL,
    diff_json      TEXT    NOT NULL,   -- [{path, old, new}] against the previous revision
    comment        TEXT
);

-- Small key/value store for runtime state (paused jobs, discovered URLs, ...).
CREATE TABLE kv (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
