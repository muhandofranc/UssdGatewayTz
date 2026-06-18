-- 004 — partition ussd_session_logs by month (RANGE on ts).
--
-- Rationale: at millions-of-rows scale, every query against the
-- single table scans the whole btree. With monthly partitions +
-- a default 24h date filter on the dashboard, queries prune to
-- ONE partition and stay fast indefinitely. Partition drops also
-- become the cheap retention primitive (vs DELETE + VACUUM).
--
-- Strategy (data-preserving):
--   1. Rename existing table aside.
--   2. Create the partitioned parent + 13 monthly partitions
--      (12 back, current, 3 forward) + a default catch-all.
--   3. Re-create every index from 001 against the parent (Postgres
--      cascades to all partitions automatically).
--   4. Copy data from the old table into the parent (router picks
--      the right partition by ts).
--   5. Drop the old table.
--
-- Idempotent guard at the top so re-running on an already-
-- partitioned table is a no-op.

DO $$
DECLARE
    _already_partitioned bool;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_partitioned_table pt
          JOIN pg_class c ON c.oid = pt.partrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'ussd_session_logs'
    ) INTO _already_partitioned;
    IF _already_partitioned THEN
        RAISE NOTICE 'ussd_session_logs is already partitioned; skipping';
        RETURN;
    END IF;

    -- 1. set aside
    EXECUTE 'ALTER TABLE ussd_session_logs RENAME TO ussd_session_logs_unpart';

    -- 2. parent partitioned table — schema matches 001 exactly EXCEPT
    --    the PK gains `ts` (Postgres requires the partition key to be
    --    part of every unique constraint, including the PK).
    EXECUTE $sql$
        CREATE TABLE ussd_session_logs (
            id                       BIGSERIAL,
            ts                       TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
            operator_id              SMALLINT     NOT NULL REFERENCES operators(id),
            operator_name            VARCHAR(32)  NOT NULL,
            shortcode_id             INTEGER      REFERENCES shortcodes(id),
            service_code             VARCHAR(64),
            session_id               VARCHAR(128) NOT NULL,
            msisdn                   VARCHAR(20),
            ussd_string              TEXT,
            direction                VARCHAR(16)  NOT NULL,
            raw_request_payload      JSONB,
            raw_response_payload     JSONB,
            handler_url              TEXT,
            handler_status_code      SMALLINT,
            handler_response_action  VARCHAR(8),
            handler_response_text    TEXT,
            handler_elapsed_ms       INTEGER,
            error_class              VARCHAR(32),
            error_detail             TEXT,
            CHECK (direction IN ('inbound', 'response')),
            PRIMARY KEY (id, ts)
        ) PARTITION BY RANGE (ts)
    $sql$;
END
$$;

-- 3. monthly partitions — 12 back, current, 3 forward. Skip the
--    monthly seed once db/014+ has converted future ranges to
--    weekly/daily: re-creating any monthly whose range is now
--    covered by a weekly partition would fail with "would overlap
--    partition" (IF NOT EXISTS only guards on NAME, not date range).
--    The _default catch-all is still ensured at the bottom either
--    way so an INSERT with an unmapped ts always lands somewhere.
DO $$
DECLARE
    cur_month date := date_trunc('month', now())::date;
    m         date;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'ussd_session_logs'
           AND (c.relname LIKE 'ussd_session_logs_w_%'
                OR c.relname LIKE 'ussd_session_logs_d_%')
    ) THEN
        RAISE NOTICE 'weekly/daily partitions present — skipping monthly seed (db/014+ owns the lifecycle)';
    ELSE
        FOR m IN
            SELECT (cur_month - (12 * INTERVAL '1 month'))::date
                 + (n * INTERVAL '1 month')
              FROM generate_series(0, 15) n
        LOOP
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS ussd_session_logs_%s
                   PARTITION OF ussd_session_logs
                   FOR VALUES FROM (%L) TO (%L)',
                to_char(m, 'YYYY_MM'),
                m,
                (m + INTERVAL '1 month')::date
            );
        END LOOP;
    END IF;
    EXECUTE 'CREATE TABLE IF NOT EXISTS ussd_session_logs_default
               PARTITION OF ussd_session_logs DEFAULT';
END
$$;

-- 4. copy data from old table -> parent (router places into the right
--    monthly partition by ts). Only runs if the old table still
--    exists (i.e. we just did the rename above). Done BEFORE the
--    indexes so the old indexes (still attached to the renamed-aside
--    table) free their names when we DROP the old table.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'ussd_session_logs_unpart'
    ) THEN
        INSERT INTO ussd_session_logs (
            id, ts, operator_id, operator_name, shortcode_id, service_code,
            session_id, msisdn, ussd_string, direction,
            raw_request_payload, raw_response_payload,
            handler_url, handler_status_code,
            handler_response_action, handler_response_text,
            handler_elapsed_ms, error_class, error_detail
        )
        SELECT
            id, ts, operator_id, operator_name, shortcode_id, service_code,
            session_id, msisdn, ussd_string, direction,
            raw_request_payload, raw_response_payload,
            handler_url, handler_status_code,
            handler_response_action, handler_response_text,
            handler_elapsed_ms, error_class, error_detail
        FROM ussd_session_logs_unpart;

        -- Re-seat the sequence past the highest id we just copied so
        -- new inserts don't collide with historical PKs.
        PERFORM setval(
            pg_get_serial_sequence('ussd_session_logs', 'id'),
            COALESCE((SELECT MAX(id) FROM ussd_session_logs), 1)
        );

        -- Drop the old table; this frees the original index names so
        -- step 5 below can re-create them on the new parent.
        DROP TABLE ussd_session_logs_unpart;
    END IF;
END
$$;

-- 5. indexes — same shape as 001, on the parent (Postgres cascades
--    to every partition). MUST be after step 4 so the original index
--    names (attached to the renamed-aside table) are freed.
CREATE INDEX IF NOT EXISTS idx_ussd_logs_ts             ON ussd_session_logs (ts);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_session        ON ussd_session_logs (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_operator_ts    ON ussd_session_logs (operator_id, ts);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_shortcode_ts   ON ussd_session_logs (shortcode_id, ts);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_msisdn_ts      ON ussd_session_logs (msisdn, ts);
-- new: operator_name is what the dashboard filters on (vs operator_id),
-- so a direct index on it skips the join + is partition-aware.
CREATE INDEX IF NOT EXISTS idx_ussd_logs_operator_name_ts
    ON ussd_session_logs (operator_name, ts);
