-- One row per job execution (or skipped / missed execution).
CREATE TABLE run (
    id           INTEGER PRIMARY KEY,
    job          TEXT    NOT NULL,
    trigger      TEXT    NOT NULL,   -- schedule | manual | event | startup
    mode         TEXT,               -- e.g. off | dry_run | live for EMHASS jobs
    scheduled_at TEXT,
    started_at   TEXT    NOT NULL,
    finished_at  TEXT,
    duration_ms  INTEGER,
    outcome      TEXT    NOT NULL,   -- running | ok | error | skipped | missed | cancelled | refused | ...
    summary      TEXT,
    error        TEXT,
    settings_rev INTEGER,
    pinned       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX run_job_started ON run (job, started_at);
CREATE INDEX run_started ON run (started_at);

-- Everything a run looked at or produced: inputs, request, response, ... (gzipped JSON).
CREATE TABLE run_artifact (
    id         INTEGER PRIMARY KEY,
    run_id     INTEGER NOT NULL REFERENCES run (id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    gz         BLOB    NOT NULL
);
CREATE INDEX run_artifact_run ON run_artifact (run_id);

CREATE TABLE log (
    id        INTEGER PRIMARY KEY,
    ts        TEXT    NOT NULL,
    level     TEXT    NOT NULL,
    component TEXT    NOT NULL,
    msg       TEXT    NOT NULL,
    run_id    INTEGER,
    job       TEXT,
    exc       TEXT
);
CREATE INDEX log_ts ON log (ts);
CREATE INDEX log_run ON log (run_id);
