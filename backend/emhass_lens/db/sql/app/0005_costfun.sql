-- Plans made with each cost function for the same inputs (Plan page → Cost functions), one row per method.
CREATE TABLE costfun_result (
    id           INTEGER PRIMARY KEY,
    run_id       INTEGER,
    compared_at  TEXT NOT NULL,
    anchor       TEXT NOT NULL,
    costfun      TEXT NOT NULL,     -- profit | cost | self-consumption
    live         INTEGER NOT NULL DEFAULT 0,  -- 1 for the method in use (its plan is EMHASS's current plan)
    optim_status TEXT,
    duration_ms  INTEGER,
    problem      TEXT,              -- why there is no plan for this method
    totals_json  TEXT,
    plan_gz      BLOB
);
CREATE INDEX costfun_result_at ON costfun_result (compared_at);
