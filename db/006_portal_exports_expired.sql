-- 006 — allow 'expired' as a terminal status for old CSVs whose
-- file has been swept off disk by the retention reaper.
--
-- Lifecycle now:
--   queued  → running → ready → expired  (file deleted after N days)
--                    \  failed           (worker error)
--                    \  queued           (zombie reaper: 'running' too long)
--
-- The /exports page uses status='expired' to hide the Download link
-- (instead of a broken 410 from a missing file). Older 'ready' rows
-- with file_path NULL also get reported as expired.

ALTER TABLE portal_exports
    DROP CONSTRAINT IF EXISTS portal_exports_status_check;

ALTER TABLE portal_exports
    ADD CONSTRAINT portal_exports_status_check
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired'));
