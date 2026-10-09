-- Qilowatt market sessions (buy/sell) the App runs itself (live) or shadows.
CREATE TABLE market_session (
    id           INTEGER PRIMARY KEY,
    direction    TEXT NOT NULL,        -- buy | sell
    source       TEXT,                 -- kratt | fusebox
    mode         TEXT,                 -- the qw_mode when the session started
    power_w      INTEGER,              -- the last commanded power, rounded to 100 W
    started_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    ended_at     TEXT,
    end_reason   TEXT,                 -- low_soc | below_gate | source_lost | mode_cleared | forced | controller_off | ...
    start_run_id INTEGER,
    end_run_id   INTEGER
);
CREATE INDEX market_session_open ON market_session (ended_at);

-- Every passive-mode / feed-in commit the App made (the cooldown survives a restart; who wrote what).
CREATE TABLE sofar_commit (
    id             INTEGER PRIMARY KEY,
    at             TEXT NOT NULL,
    owner          TEXT NOT NULL,      -- plan | market
    register_group TEXT NOT NULL,      -- passive | feedin
    grid_w         REAL,
    battery_max_w  REAL,
    battery_min_w  REAL,
    feedin_w       REAL,
    run_id         INTEGER,
    ok             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX sofar_commit_group_at ON sofar_commit (register_group, at);

-- Every observed press of the Sofar apply / feed-in buttons, whoever pressed (EEPROM wear events).
CREATE TABLE sofar_press (
    id        INTEGER PRIMARY KEY,
    at        TEXT NOT NULL,
    entity_id TEXT NOT NULL
);
CREATE INDEX sofar_press_at ON sofar_press (at);
