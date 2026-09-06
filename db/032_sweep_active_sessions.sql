-- 032_sweep_active_sessions.sql
--
-- The `ussd_active_sessions` sweeper. db/002 specified it in a trailing
-- comment ("Cleanup helper — run periodically (cron / Phase 4 sweeper)")
-- and nothing ever implemented it: it is absent from TASKS_DAILY and
-- TASKS_INTRADAY in app/scheduler.py, from every migration 001-031, and
-- there is no other DELETE against the table outside
-- expire_active_session()'s single-session call.
--
-- Measured on production before this migration:
--
--     operator   total rows   idle >10min   live
--     vodacom       367,742       367,734      8
--     airtel      1,049,111     1,049,073     38
--     tigo        1,465,267     1,465,267      0
--     halotel         1,582         1,582      0
--                 ---------     ---------    ---
--                 2,883,702     2,883,656     46
--
-- 2.88M rows to hold 46 live sessions, on the table db/002 opens by
-- calling HOT and saying "keep it small".
--
-- Why the leak is operator-shaped: expire_active_session() is called on
-- handler END (main.py:455), terminal events (main.py:320), the
-- maintenance short-circuit (main.py:366) and shortcode_not_found
-- (main.py:417) — every path that ENDS a session. None of those fire
-- when a customer simply walks away mid-menu, and that is the common
-- case. Halotel escapes it because the async-outbound path expires the
-- row on both of its own exits (main.py:514, main.py:562); the three
-- synchronous operators have no such backstop and accumulate forever.
--
-- Why it matters — the cost is latency, not correctness. The stale rows
-- are individually harmless (a reused session_id would misroute, since
-- upsert_active_session deliberately does not update service_code on
-- conflict — see db.py:285-288 — but at 137 shortcode_not_found legs in
-- 24h across both exposed operators, MNO session ids are evidently not
-- being reused at any rate). The real damage is that this is the single
-- hottest table in the gateway: get_active_session + upsert_active_session
-- run on EVERY leg, synchronously, on the event loop (every route is
-- `async def` and psycopg2 is blocking — there is no run_in_executor
-- anywhere in app/). A PRIMARY KEY over VARCHAR(128) across 2.9M rows,
-- plus the dead tuples from rewriting last_seen_at on every leg, is a
-- large index competing for shared_buffers on the exact call that stalls
-- a worker. Every millisecond of it is paid twice per leg by all four
-- operators.
--
-- Why a PROCEDURE and not a FUNCTION (same reasoning as db/026):
--   A function body is one transaction, so clearing the 2.88M-row
--   backlog would hold one snapshot open for the whole run and dump the
--   entire delete into a single WAL transaction. A procedure COMMITs
--   between batches, so each batch is short, replicas keep up, and an
--   interrupted run keeps the work it already did.
--
-- Why ctid batching rather than one DELETE ... WHERE last_seen_at < cutoff:
--   The single statement takes row locks on 2.88M tuples in one
--   transaction. Batching by ctid keeps each transaction bounded and
--   lets idx_active_sessions_last_seen (db/002) drive a cheap
--   index-scan-plus-LIMIT for each batch.
--
-- Idempotent. Safe to re-run.

CREATE OR REPLACE PROCEDURE sweep_active_sessions(
    idle_minutes int    DEFAULT 10,
    batch_size   int    DEFAULT 20000,
    max_batches  int    DEFAULT 200,
    INOUT deleted bigint DEFAULT 0
)
LANGUAGE plpgsql
AS $$
DECLARE
    cutoff timestamptz;
    n      int;
    i      int := 0;
BEGIN
    deleted := 0;

    LOOP
        i := i + 1;
        EXIT WHEN i > max_batches;

        -- Recomputed per batch. now() is transaction-start time and a
        -- procedure COMMITs between batches, so the cutoff tracks the
        -- clock across a long backfill instead of freezing at the value
        -- it had when the run began.
        cutoff := now() - make_interval(mins => idle_minutes);

        -- Bound the wait, not the work. A stale row is by definition not
        -- one a live leg is upserting, so contention here should be nil;
        -- if it somehow isn't, give up rather than let a scheduler tick
        -- block behind another transaction. SET LOCAL is re-applied each
        -- iteration because the COMMIT below ends the transaction it is
        -- scoped to.
        SET LOCAL lock_timeout = '5s';

        -- ctid = ANY(ARRAY(...)) materialises the victim list before the
        -- delete, which keeps the plan an index scan + LIMIT. The
        -- IN (subquery) spelling can plan as a self-join over the whole
        -- table instead.
        DELETE FROM ussd_active_sessions
         WHERE ctid = ANY (ARRAY(
                   SELECT ctid
                     FROM ussd_active_sessions
                    WHERE last_seen_at < cutoff
                    LIMIT batch_size
               ));

        GET DIAGNOSTICS n = ROW_COUNT;
        deleted := deleted + n;
        COMMIT;

        EXIT WHEN n < batch_size;   -- short batch ⇒ nothing left to sweep

        RAISE NOTICE 'swept % rows (batch %/%)', deleted, i, max_batches;
    END LOOP;

    IF i > max_batches THEN
        -- Only reachable on a backlog larger than batch_size*max_batches.
        -- Not an error: the next run continues where this one stopped.
        RAISE NOTICE 'batch cap reached — % rows swept, more may remain', deleted;
    END IF;
END;
$$;

COMMENT ON PROCEDURE sweep_active_sessions(int, int, int, bigint) IS
    'Deletes ussd_active_sessions rows idle longer than idle_minutes, in '
    'committed batches of batch_size, at most max_batches per run. '
    'Implements the cleanup db/002 specified but never shipped. Runs from '
    'TASKS_INTRADAY in app/scheduler.py.';


-- ---------- Rollout (first run is NOT just a deploy) ------------------
-- Deleting the backlog leaves ~2.88M dead tuples. Autovacuum marks them
-- reusable but NEITHER the heap NOR the primary key index shrinks, and
-- the oversized index is the entire reason this migration exists. Ship
-- the scheduler change without the rebuild and you get the correctness
-- fix and none of the latency win.
--
--   -- 0. Reversibility. Nothing references this copy; drop it once the
--   --    numbers below look right.
--   CREATE TABLE ussd_active_sessions_presweep_20260906 AS
--   SELECT * FROM ussd_active_sessions;
--
--   -- 1. Drain the backlog once, by hand, watching the NOTICEs --
--   --    before the scheduler ever sees it. ~145 batches.
--   CALL sweep_active_sessions(10, 20000, 200, NULL);
--
--   -- 2. Confirm it is down to the live working set (expect ~tens).
--   SELECT operator_id, count(*) FROM ussd_active_sessions GROUP BY 1;
--
--   -- 3. Reclaim the space. REINDEX CONCURRENTLY needs PG12+; check.
--   SELECT current_setting('server_version_num')::int >= 120000;
--   REINDEX TABLE CONCURRENTLY ussd_active_sessions;
--   VACUUM (ANALYZE) ussd_active_sessions;
--
--   -- On PG11 or older, instead of step 3: VACUUM (FULL, ANALYZE). It
--   -- takes ACCESS EXCLUSIVE on a hot table, but with only tens of live
--   -- rows left it rewrites almost nothing. SET lock_timeout first so
--   -- it yields rather than queueing the gateway's writes behind it.
--
-- Take pg_total_relation_size('ussd_active_sessions') before step 1 and
-- after step 3; that delta is whether this was worth doing.
--
-- What to watch afterwards: a swept session that receives a late leg is
-- a cache miss, and for Vodacom and Halotel a cache miss means
-- service_code = '' (vodacom.py:206, halotel.py:411) and therefore a
-- shortcode_not_found. At a 10-minute cutoff against MNO gateway TTLs of
-- 30-120s that should be nil, but shortcode_not_found is the counter to
-- watch (137 per 24h at the time of writing). idle_minutes is a
-- parameter precisely so it can be raised without a migration.
