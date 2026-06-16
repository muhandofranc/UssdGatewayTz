# Postgres vs MySQL — why Postgres

This gateway picked **Postgres** for the external DB. Reasoning:

1. **JSONB for raw payloads.** Every MNO callback's raw body is
   logged for audit + debug. Postgres JSONB has GIN indexes; MySQL's
   JSON type has weaker indexing. We *will* eventually want to query
   inside payloads (e.g. "show all sessions where the Vodacom payload
   carried `dataitem.name = 'TransactionStatus'`").
2. **Window functions for billing.** Vodacom's 20s billable-session
   semantics — same `session_id` spanning 22s is two sessions — is a
   textbook `OVER (PARTITION BY session_id ORDER BY ts)` aggregation.
   Postgres window functions are well-trodden; MySQL only got them in
   8.0 and the planner is less reliable on time-series.
3. **Time-series partitioning.** USSD logs grow fast. Postgres native
   `PARTITION BY RANGE (ts)` per month/week makes deletes cheap (drop
   partition) and reports fast (planner skips irrelevant partitions).
4. **Org consistency.** Every other pawabox project (payments, sms,
   jubilee dashboard) is Postgres. Same backup, monitoring, replication
   runbooks apply.

MySQL would have been the right pick only if the external DB host
were already running MySQL and you weren't getting a Postgres instance.

## What schema features we actually depend on

- `gen_random_uuid()` (pgcrypto extension) for primary keys.
- `JSONB` columns for raw MNO payloads.
- `PARTITION BY RANGE (ts)` on `ussd_session_logs` (deferred to Phase
  4 hardening — Phase 1 ships as a regular table for simplicity).
- `now()` + `timestamptz` (microsecond precision) for the ts column.

Nothing exotic. Any Postgres ≥ 13 works.
