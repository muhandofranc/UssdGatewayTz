-- 017_session_logs_direction_async_outbound.sql
--
-- Widen the ussd_session_logs.direction CHECK constraint to admit
-- 'async_outbound', the value main.py writes for async-MNO adapter
-- log rows (currently only Halotel — adapters with
-- is_async_outbound=True). Before this migration the constraint only
-- allowed 'inbound' and 'response', so EVERY halotel forward+push row
-- (direction='async_outbound') was rejected by Postgres and
-- `log_leg` swallowed the exception (per its best-effort contract).
-- Visible symptom: dashboard `ussd_session_logs` rows for halotel
-- never appeared for the START / INPUT / END legs that went through
-- the async pipeline, even though customers got their menus.
--
-- This migration is forward-only and idempotent:
--   * drops the old constraint by name if it exists,
--   * adds the new constraint with the widened value set.
--
-- The constraint name carries the `1` suffix that pg auto-applied
-- when 001_init.sql ran ('ussd_session_logs_direction_check1') —
-- we drop both possible names to be safe across environments that
-- may have applied the original DDL slightly differently.
--
-- Naming: the new constraint is `ussd_session_logs_direction_check`
-- (no numeric suffix) so future migrations don't accumulate _check2,
-- _check3, etc.
--
-- No data backfill is possible: the rejected rows were never
-- persisted. Going forward (after this migration), new async_outbound
-- rows will land in the table normally.

BEGIN;

ALTER TABLE ussd_session_logs
    DROP CONSTRAINT IF EXISTS ussd_session_logs_direction_check1;

ALTER TABLE ussd_session_logs
    DROP CONSTRAINT IF EXISTS ussd_session_logs_direction_check;

ALTER TABLE ussd_session_logs
    ADD CONSTRAINT ussd_session_logs_direction_check
    CHECK (direction IN ('inbound', 'response', 'async_outbound'));

COMMIT;
