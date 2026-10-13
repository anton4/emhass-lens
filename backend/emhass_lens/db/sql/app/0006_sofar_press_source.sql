-- Who pressed each Sofar button: EMHASS Lens (with the run), an automation, a user, or not known.
ALTER TABLE sofar_press ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown';  -- lens | automation | user | unknown
ALTER TABLE sofar_press ADD COLUMN run_id INTEGER;

-- Presses recorded before this: ours where one of our commits lies within 30 s.
UPDATE sofar_press SET source = 'lens'
WHERE EXISTS (
    SELECT 1 FROM sofar_commit c
    WHERE c.ok = 1 AND ABS(julianday(c.at) - julianday(sofar_press.at)) * 86400 <= 30
);
