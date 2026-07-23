-- 021_reset_seed_sequences.sql
--
-- Repair + backstop for the SMALLSERIAL identity sequences on the seed
-- tables (operators, roles, permissions).
--
-- Root cause of the crash-loop this fixes:
--   psycopg2.errors.SequenceGeneratorLimitExceeded:
--     nextval: reached maximum value of sequence "operators_id_seq" (32767)
--
-- db_init re-applies every migration on each boot, and the seed INSERTs
-- historically used `... ON CONFLICT DO NOTHING`. Postgres evaluates the
-- column DEFAULT (nextval) for every candidate row BEFORE detecting the
-- conflict, so each boot advanced these SMALLSERIAL sequences by a few
-- values even though no rows were inserted. Over thousands of restarts
-- operators_id_seq reached its SMALLINT ceiling (32767) and db_init
-- began exiting non-zero on startup → container restart loop.
--
-- 001_init.sql now seeds with `INSERT ... SELECT ... WHERE NOT EXISTS`
-- (no nextval on a no-op re-run), which stops the leak at the source.
-- This migration runs LAST on every boot and additionally:
--   1. REPAIRS any sequence already advanced by the old behaviour,
--      pulling it back to the table's true MAX(id).
--   2. Acts as a BACKSTOP that neutralises any residual per-boot burn
--      from other seed migrations (010/011/012 still use ON CONFLICT on
--      roles/permissions), so the net value can never accumulate toward
--      the ceiling again.
--
-- Idempotent and re-run safe. setval(..., true) means the NEXT nextval()
-- returns MAX(id)+1, so no id ever collides with an existing row.
--
-- CAVEAT: a database whose sequence is ALREADY at the 32767 ceiling
-- cannot self-heal purely by deploying this file — 001's seed INSERT
-- runs first and (pre-rewrite images) crashes before this migration is
-- reached. Once the image carries the 001 WHERE-NOT-EXISTS rewrite above,
-- that first-boot crash is gone and this reset repairs the sequence. On
-- an already-stuck DB still running an old image, do a one-off manual
--   SELECT setval('operators_id_seq',
--                 (SELECT COALESCE(MAX(id),1) FROM operators), true);
-- to unblock it immediately.

SELECT setval(pg_get_serial_sequence('operators', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 1) FROM operators), 1), true);

SELECT setval(pg_get_serial_sequence('roles', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 1) FROM roles), 1), true);

SELECT setval(pg_get_serial_sequence('permissions', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 1) FROM permissions), 1), true);
