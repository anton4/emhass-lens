-- Measured quarter-hour means of what EMHASS plans, read from the Home Assistant recorder.
CREATE TABLE measurement (
    slot_utc  TEXT NOT NULL,   -- slot start (core.clock.iso)
    quantity  TEXT NOT NULL,   -- grid | batt | pv | load | soc
    value     REAL NOT NULL,   -- W in EMHASS's signs, or SOC 0–1; time-weighted mean over the slot
    coverage  REAL NOT NULL,   -- share of the slot that had a numeric state (0–1)
    entity_id TEXT NOT NULL,
    PRIMARY KEY (slot_utc, quantity)
);

-- The few plan columns the accuracy view compares, one row per slot of every stored plan,
-- so past plans can be read without decompressing plan_snapshot.plan_gz.
CREATE TABLE plan_row (
    snapshot_id  INTEGER NOT NULL REFERENCES plan_snapshot (id) ON DELETE CASCADE,
    slot_utc     TEXT    NOT NULL,   -- normalised to UTC (EMHASS rows carry a local offset)
    p_grid       REAL,
    p_batt       REAL,
    p_pv         REAL,
    p_load       REAL,
    p_deferrable REAL,
    soc          REAL,
    PRIMARY KEY (snapshot_id, slot_utc)
);
CREATE INDEX plan_row_slot ON plan_row (slot_utc);
