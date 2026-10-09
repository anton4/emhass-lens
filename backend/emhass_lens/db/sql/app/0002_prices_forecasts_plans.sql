-- Nord Pool delivery days (CET dates) and their fetch state.
CREATE TABLE price_day (
    area               TEXT    NOT NULL,
    day                TEXT    NOT NULL,   -- CET delivery date
    state              TEXT,               -- Final | Preliminary | Unknown
    slots              INTEGER NOT NULL DEFAULT 0,
    resolution_min     INTEGER,
    updated_at         TEXT,               -- Nord Pool's updatedAt
    last_attempt       TEXT,
    last_success       TEXT,
    http_status        INTEGER,
    error              TEXT,
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    not_published      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (area, day)
);

-- Raw spot prices, one row per 15-minute slot (hourly data is split into quarters).
CREATE TABLE price_slot (
    area      TEXT NOT NULL,
    start_utc TEXT NOT NULL,
    end_utc   TEXT NOT NULL,
    day       TEXT NOT NULL,
    eur_mwh   REAL NOT NULL,
    PRIMARY KEY (area, start_utc)
);

-- Price forecasts as fetched (kept for a while to show forecast accuracy).
CREATE TABLE forecast_snapshot (
    id         INTEGER PRIMARY KEY,
    provider   TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    issued_at  TEXT,
    digest     TEXT NOT NULL,
    meta_json  TEXT NOT NULL
);
CREATE INDEX forecast_snapshot_provider ON forecast_snapshot (provider, fetched_at);

CREATE TABLE forecast_point (
    snapshot_id INTEGER NOT NULL REFERENCES forecast_snapshot (id) ON DELETE CASCADE,
    start_utc   TEXT    NOT NULL,
    end_utc     TEXT    NOT NULL,
    eur_mwh     REAL    NOT NULL,
    PRIMARY KEY (snapshot_id, start_utc)
);

-- EMHASS plans as read from GET /api/v1/plan (one row per optimization).
CREATE TABLE plan_snapshot (
    id           INTEGER PRIMARY KEY,
    generated_at TEXT    NOT NULL UNIQUE,
    fetched_at   TEXT    NOT NULL,
    driver       TEXT    NOT NULL,   -- app | external (e.g. the HACS integration)
    run_id       INTEGER,
    last_run_json TEXT,
    plan_gz      BLOB    NOT NULL
);

-- Problems: when they started and ended.
CREATE TABLE problem_event (
    id         INTEGER PRIMARY KEY,
    key        TEXT NOT NULL,
    severity   TEXT NOT NULL,
    title      TEXT NOT NULL,
    detail     TEXT,
    hint       TEXT,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    notified   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX problem_event_open ON problem_event (key, ended_at);
