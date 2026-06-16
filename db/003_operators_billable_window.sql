-- 003 — per-MNO billable-window configuration.
--
-- Each TZ MNO charges per N-second window of session duration. A
-- session of duration D is `GREATEST(1, CEIL(D / window))` billable
-- units (any spill into the next window = whole next window).
--
-- Halotel is per-leg flat (no duration-based window) — represented
-- as NULL so the gateway / dashboard fall back to "—" instead of
-- computing a fake unit count.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + only UPDATE when still NULL,
-- so super_admin's later edits via the dashboard are preserved across
-- re-runs of `python -m app.db_init`.

ALTER TABLE operators
    ADD COLUMN IF NOT EXISTS billable_window_secs SMALLINT
        CHECK (billable_window_secs IS NULL OR
              (billable_window_secs >= 1 AND billable_window_secs <= 600));

UPDATE operators SET billable_window_secs = 20 WHERE name = 'vodacom' AND billable_window_secs IS NULL;
UPDATE operators SET billable_window_secs = 30 WHERE name = 'airtel'  AND billable_window_secs IS NULL;
UPDATE operators SET billable_window_secs = 30 WHERE name = 'tigo'    AND billable_window_secs IS NULL;
-- Halotel intentionally NULL — per-leg billing, no duration window.
