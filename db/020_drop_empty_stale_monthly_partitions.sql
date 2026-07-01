-- 020_drop_empty_stale_monthly_partitions.sql
--
-- Cleanup: drops the empty monthly partitions from db/004 that were
-- left behind by db/014's cutover from monthly → weekly partitioning.
--
-- Context
-- -------
-- db/014 replaced monthly partitions with weekly ones going forward.
-- It DROP'd the empty FUTURE monthly partitions to make room for
-- weeklies, but PAST monthly partitions (before the cutover moment)
-- were left in place because retention would naturally sweep them
-- once they aged past 90 days.
--
-- On DBs where the gateway was quiet before the cutover, some of
-- those PAST monthly partitions have zero rows. They're harmless
-- (0 bytes, only a hair of planner overhead per query) but noisy
-- in partition inventories. This file cleans them up idempotently.
--
-- Safety
-- ------
-- Each candidate partition is dropped ONLY when count(*) = 0. If a
-- partition has data (unexpected — but possible on installs where
-- data was backfilled to old months), the DROP is skipped and a
-- NOTICE is raised so the operator sees which partitions were kept.
--
-- Fresh installs: db/004 only creates partitions for the CURRENT
-- + next 6 months as-of install time, so on a July-2026 fresh
-- install neither 2026_04 nor 2026_05 will exist. The IF EXISTS
-- guard makes this a no-op there.

BEGIN;

DO $$
DECLARE
    candidates text[] := ARRAY[
        'ussd_session_logs_2026_04',
        'ussd_session_logs_2026_05'
    ];
    partname text;
    row_count bigint;
BEGIN
    FOREACH partname IN ARRAY candidates
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class WHERE relname = partname
        ) THEN
            RAISE NOTICE 'partition % does not exist — skipping', partname;
            CONTINUE;
        END IF;

        EXECUTE format('SELECT count(*) FROM %I', partname) INTO row_count;

        IF row_count = 0 THEN
            EXECUTE format('DROP TABLE %I', partname);
            RAISE NOTICE 'dropped empty partition %', partname;
        ELSE
            RAISE NOTICE 'kept partition % (% row(s) present — retention will handle)',
                partname, row_count;
        END IF;
    END LOOP;
END $$;

COMMIT;
