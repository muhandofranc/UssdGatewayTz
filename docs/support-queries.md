# Support queries — USSD Gateway TZ

Ready-to-run SQL for answering support questions from the gateway
database: what happened to a subscriber, why a shortcode is failing,
how sessions are ending, and whether the gateway itself is healthy.

Every query is **read-only**. Change the values marked `-- ← change`
and run it as is.

---

## Before you start

1. **Always keep a time limit in the query.** `ussd_session_logs` holds
   millions of rows a day, split into weekly partitions. A query
   without a `ts >= …` condition reads every partition and can run for
   minutes and slow the gateway. Every query below has one. Keep it,
   and widen it only as far as you need.
2. **Cap the run time** at the start of your session:

   ```sql
   SET statement_timeout = '60s';
   ```

3. **Times are stored in UTC.** The queries convert to Tanzania time
   (EAT, UTC+3) with `AT TIME ZONE 'Africa/Dar_es_Salaam'`.
4. **Phone numbers are stored as `255…`** with no `+` and no leading
   `0`. Search for `255712345678`, not `0712345678`.
5. **Live data covers the last 120 days.** Older rows are moved to
   `ussd_session_logs_archive` (see [Older than 120 days](#8-older-than-120-days-archive)).

---

## How the data fits together

| Table | What one row is |
|---|---|
| `ussd_session_logs` | One message ("leg") in a USSD session: something the network sent, or what we answered. A session is all rows with the same `session_id` + `operator_name`. |
| `ussd_active_sessions` | A session the gateway currently considers open. Deleted when the session ends. |
| `shortcodes` | Routing: which handler URL serves a dialled code on a network, and its status. |
| `operators` | The four networks: `vodacom`, `airtel`, `tigo` (Yas), `halotel`. |
| `daily_session_summary` | Pre-counted sessions per day, network and shortcode. This is what the dashboard Summary page reads. Filled nightly, up to yesterday. |
| `portal_users`, `roles` | Dashboard accounts. |
| `portal_audit_log` | Who did what in the dashboard. |

### Key columns in `ussd_session_logs`

| Column | Meaning |
|---|---|
| `direction` | `inbound` = the network told us something (cancel, timeout, ack) or the gateway expired the session. `response` = our menu reply (Vodacom, Airtel, Tigo). `async_outbound` = our menu pushed to Halotel. |
| `ussd_string` | The subscriber's input trail so far, e.g. `1*2*500`. |
| `handler_response_action` | `CON` = menu shown and session continues; `END` = session finished. |
| `handler_response_text` | The menu text sent to the subscriber. On terminal rows it says how the session ended (below). |
| `handler_status_code`, `handler_elapsed_ms` | The application's HTTP status and response time. |
| `error_class` | Empty when fine. Otherwise one of the values below. |
| `error_detail` | Human-readable reason for the error. |

### `error_class` values

| Value | Meaning |
|---|---|
| `shortcode_not_found` | Dialled code not configured, **or** the session was already ended by the gateway and the subscriber pressed a key afterwards. The subscriber sees "Service not configured". |
| `timeout` | The application did not answer in time (the shortcode's `timeout_secs`). |
| `non2xx` | The application answered with an HTTP error (4xx/5xx). |
| `transport` | Could not reach the application at all (DNS, connection refused, TLS). |
| `maintenance` / `deactivated` | The shortcode is switched off; the subscriber got its status message. |
| `auth_failed` | Halotel sent wrong credentials. |
| `outbound_unconfigured` | Halotel push URL/credentials are not set on the gateway. |

### How a session can end (`handler_response_text` on `inbound` rows)

| Value | Who ended it |
|---|---|
| `user_cancelled_session` | The subscriber cancelled (Vodacom, Halotel). |
| `provider_session_termination` | The network ended it: a timeout, a failed Vodacom premium charge, or Vodacom's **own 60-second idle cut-off** (Vodacom reports that as a cancel; the gateway relabels a cancel on a session idle 55s or more). |
| `system_session_termination` | **The gateway**, after the network's idle limit with no input. The application is notified. These rows have `raw_request_payload->>'_source' = 'gateway_session_expiry'`. |

Rows logged before the rename carry the old values: `user_cancelled`
(which included Vodacom's own cut-off), `timeout`, `charge_failed`
and `session_expired`. The queries below match both.

A session whose last row is a `CON` and has no terminal row simply
stopped: the subscriber walked away and nothing has expired it yet.

---

## 1. Subscriber questions

### 1.1 Everything a subscriber did in the last 24 hours

```sql
SELECT ts AT TIME ZONE 'Africa/Dar_es_Salaam' AS time_eat,
       operator_name, service_code, session_id, direction,
       ussd_string, handler_response_action AS action,
       left(handler_response_text, 80)      AS reply,
       error_class, handler_elapsed_ms     AS ms
  FROM ussd_session_logs
 WHERE msisdn = '255712345678'                      -- ← change
   AND ts >= now() - interval '24 hours'
 ORDER BY ts;
```

### 1.2 A subscriber's sessions, one row each, with how each ended

```sql
WITH legs AS (
  SELECT session_id, operator_name, service_code, ts, direction,
         handler_response_action, handler_response_text, error_class,
         row_number() OVER (PARTITION BY session_id, operator_name ORDER BY ts DESC) AS rn_last
    FROM ussd_session_logs
   WHERE msisdn = '255712345678'                    -- ← change
     AND ts >= now() - interval '7 days'
)
SELECT session_id, operator_name,
       max(service_code)                                   AS shortcode,
       min(ts) AT TIME ZONE 'Africa/Dar_es_Salaam'         AS started_eat,
       max(ts) AT TIME ZONE 'Africa/Dar_es_Salaam'         AS last_seen_eat,
       round(extract(epoch FROM max(ts) - min(ts)))        AS duration_s,
       count(*)                                            AS legs,
       max(CASE WHEN rn_last = 1 THEN
             CASE
               WHEN error_class IS NOT NULL                        THEN 'error: ' || error_class
               WHEN direction = 'inbound'                          THEN 'ended: ' || handler_response_text
               WHEN handler_response_action = 'END'                THEN 'completed (application ended it)'
               ELSE 'open / abandoned (last menu still showing)'
             END END)                                      AS outcome
  FROM legs
 GROUP BY session_id, operator_name
 ORDER BY started_eat DESC;
```

### 1.3 The full trail of one session

Keep the operator in the filter: Vodacom reuses session ids over time.

```sql
SELECT ts AT TIME ZONE 'Africa/Dar_es_Salaam' AS time_eat,
       direction, ussd_string,
       handler_response_action AS action,
       handler_response_text   AS reply,
       handler_status_code     AS http,
       handler_elapsed_ms      AS ms,
       error_class, error_detail
  FROM ussd_session_logs
 WHERE session_id    = '380431891532960'            -- ← change
   AND operator_name = 'tigo'                       -- ← change
   AND ts >= now() - interval '7 days'
 ORDER BY ts;
```

To see exactly what the network sent and what we answered, add
`raw_request_payload, raw_response_payload` to the select list.

### 1.4 Find a session when you only know the phone number and roughly when

```sql
SELECT DISTINCT ON (session_id, operator_name)
       session_id, operator_name, service_code,
       ts AT TIME ZONE 'Africa/Dar_es_Salaam' AS first_leg_eat
  FROM ussd_session_logs
 WHERE msisdn = '255712345678'                                         -- ← change
   AND ts >= timestamp '2026-10-21 13:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (EAT)
   AND ts <  timestamp '2026-10-21 14:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (EAT)
 ORDER BY session_id, operator_name, ts;
```

---

## 2. Shortcode questions

### 2.1 How a shortcode is configured

```sql
SELECT s.id, o.name AS operator, s.code, s.label,
       s.status, s.status_message, s.environment, s.payload_format,
       s.handler_url, s.auth_mode, s.timeout_secs, s.verify_tls,
       u.name AS owner, u.email AS owner_email, s.updated_at
  FROM shortcodes s
  JOIN operators    o ON o.id = s.operator_id
  JOIN portal_users u ON u.id = s.owner_user_id
 WHERE s.code = '*147*04#'                          -- ← change
 ORDER BY o.name, s.environment;
```

`bearer_token` is left out on purpose: don't copy it into tickets.

### 2.2 Shortcodes that are switched off

```sql
SELECT o.name AS operator, s.code, s.label, s.status, s.status_message,
       s.status_set_at AT TIME ZONE 'Africa/Dar_es_Salaam' AS since_eat,
       p.email AS set_by
  FROM shortcodes s
  JOIN operators o ON o.id = s.operator_id
  LEFT JOIN portal_users p ON p.id = s.status_set_by_id
 WHERE s.status <> 'active'
 ORDER BY s.status_set_at DESC NULLS LAST;
```

### 2.3 How many subscribers a switched-off shortcode turned away today

```sql
SELECT operator_name, service_code, error_class,
       count(DISTINCT session_id) AS sessions_turned_away
  FROM ussd_session_logs
 WHERE error_class IN ('maintenance', 'deactivated')
   AND ts >= now() - interval '24 hours'
 GROUP BY 1, 2, 3
 ORDER BY 4 DESC;
```

### 2.4 Active shortcodes with no traffic in the last 24 hours

```sql
SELECT o.name AS operator, s.code, s.label, s.environment
  FROM shortcodes s
  JOIN operators o ON o.id = s.operator_id
 WHERE s.status = 'active'
   AND NOT EXISTS (
         SELECT 1 FROM ussd_session_logs l
          WHERE l.shortcode_id = s.id
            AND l.ts >= now() - interval '24 hours')
 ORDER BY o.name, s.code;
```

### 2.5 Codes subscribers dialled that are not configured

```sql
SELECT operator_name, service_code,
       count(DISTINCT session_id) AS sessions,
       count(DISTINCT msisdn)     AS subscribers
  FROM ussd_session_logs
 WHERE error_class = 'shortcode_not_found'
   AND service_code <> ''          -- empty = expired session, see 4.3
   AND ts >= now() - interval '24 hours'
 GROUP BY 1, 2
 ORDER BY 3 DESC
 LIMIT 50;
```

---

## 3. Errors and slow applications

### 3.1 Errors in the last hour, by network and type

```sql
SELECT operator_name, error_class,
       count(*)                   AS legs,
       count(DISTINCT session_id) AS sessions
  FROM ussd_session_logs
 WHERE error_class IS NOT NULL
   AND ts >= now() - interval '1 hour'
 GROUP BY 1, 2
 ORDER BY legs DESC;
```

### 3.2 Error rate per shortcode today

```sql
SELECT operator_name, service_code,
       count(DISTINCT session_id)                                        AS sessions,
       count(DISTINCT session_id) FILTER (WHERE error_class IS NOT NULL) AS sessions_with_error,
       round(100.0 * count(DISTINCT session_id) FILTER (WHERE error_class IS NOT NULL)
             / nullif(count(DISTINCT session_id), 0), 1)                 AS error_pct
  FROM ussd_session_logs
 WHERE ts >= now() - interval '24 hours'
   AND shortcode_id IS NOT NULL
 GROUP BY 1, 2
HAVING count(DISTINCT session_id) >= 20
 ORDER BY error_pct DESC;
```

### 3.3 Latest errors from one shortcode's application, with its reply

Use this to send the application owner the exact failure.

```sql
SELECT ts AT TIME ZONE 'Africa/Dar_es_Salaam' AS time_eat,
       session_id, msisdn, ussd_string,
       error_class, handler_status_code AS http, handler_elapsed_ms AS ms,
       error_detail,
       left(raw_response_payload::text, 300) AS application_reply
  FROM ussd_session_logs
 WHERE service_code = '*148*33#'                    -- ← change
   AND operator_name = 'halotel'                    -- ← change
   AND error_class IN ('timeout', 'non2xx', 'transport')
   AND ts >= now() - interval '24 hours'
 ORDER BY ts DESC
 LIMIT 50;
```

### 3.4 Application response times per shortcode today

Slow applications cause network timeouts; most networks give us only a
few seconds per reply.

```sql
SELECT operator_name, service_code,
       count(*) AS replies,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY handler_elapsed_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY handler_elapsed_ms) AS p95_ms,
       max(handler_elapsed_ms)                                           AS max_ms,
       count(*) FILTER (WHERE error_class = 'timeout')                   AS timeouts
  FROM ussd_session_logs
 WHERE direction IN ('response', 'async_outbound')
   AND handler_elapsed_ms IS NOT NULL
   AND ts >= now() - interval '24 hours'
 GROUP BY 1, 2
HAVING count(*) >= 20
 ORDER BY p95_ms DESC;
```

### 3.5 Hour-by-hour errors for one shortcode (when did it start failing?)

```sql
SELECT date_trunc('hour', ts AT TIME ZONE 'Africa/Dar_es_Salaam') AS hour_eat,
       count(*)                                    AS legs,
       count(*) FILTER (WHERE error_class IS NOT NULL) AS errors,
       string_agg(DISTINCT error_class, ', ')      AS error_types
  FROM ussd_session_logs
 WHERE service_code = '*147*04#'                    -- ← change
   AND operator_name = 'tigo'                       -- ← change
   AND ts >= now() - interval '48 hours'
 GROUP BY 1
 ORDER BY 1;
```

---

## 4. How sessions are ending

### 4.1 Session endings per network today

```sql
SELECT operator_name, handler_response_text AS ended_by,
       count(*) AS sessions
  FROM ussd_session_logs
 WHERE direction = 'inbound'
   AND handler_response_text IN ('user_cancelled_session', 'provider_session_termination',
                                 'system_session_termination',
                                 -- before the rename
                                 'user_cancelled', 'timeout', 'charge_failed', 'session_expired')
   AND ts >= now() - interval '24 hours'
 GROUP BY 1, 2
 ORDER BY 1, 3 DESC;
```

### 4.2 Expiry notifications the application did not receive or rejected

When the gateway expires a session it calls the application. These
rows show where that failed.

```sql
SELECT ts AT TIME ZONE 'Africa/Dar_es_Salaam' AS time_eat,
       operator_name, service_code, session_id,
       handler_status_code AS http, error_class, error_detail
  FROM ussd_session_logs
 WHERE handler_response_text IN ('system_session_termination', 'session_expired')
   AND (handler_status_code IS DISTINCT FROM 200
        OR error_class IS NOT NULL
        OR error_detail LIKE 'handler not notified%')
   AND ts >= now() - interval '24 hours'
 ORDER BY ts DESC
 LIMIT 100;
```

`error_detail = 'handler not notified: unresolved'` means the gateway
could not tell which shortcode the session belonged to.
`'handler not notified: shortcode_inactive'` means the shortcode was
switched off, so there was nothing to notify.

### 4.3 Subscribers cut off by the idle limit

The gateway expired the session, then the subscriber pressed a key
and got "Service not configured". A steady count here means the
network's idle limit (`USSD_SESSION_IDLE_EXPIRY_SECS_<NETWORK>`) is
too short.

```sql
WITH s AS (
  SELECT session_id, operator_name,
         min(ts) FILTER (WHERE handler_response_text IN ('system_session_termination', 'session_expired')) AS expired_at,
         max(ts) FILTER (WHERE error_class = 'shortcode_not_found')       AS rejected_at
    FROM ussd_session_logs
   WHERE ts >= now() - interval '24 hours'
   GROUP BY 1, 2
)
SELECT operator_name,
       count(*)                                             AS cut_off_sessions,
       round(avg(extract(epoch FROM rejected_at - expired_at))) AS avg_s_late
  FROM s
 WHERE rejected_at > expired_at
 GROUP BY 1
 ORDER BY 2 DESC;
```

### 4.4 Sessions ended twice (gateway and network both)

Should be near zero for Vodacom when its idle limit is above 60s.

```sql
SELECT operator_name, count(*) AS sessions
  FROM (
    SELECT session_id, operator_name
      FROM ussd_session_logs
     WHERE ts >= now() - interval '24 hours'
       AND direction = 'inbound'
     GROUP BY 1, 2
    HAVING bool_or(handler_response_text IN ('system_session_termination', 'session_expired'))
       AND bool_or(handler_response_text IN ('user_cancelled_session', 'provider_session_termination',
                                            'user_cancelled', 'timeout'))
  ) x
 GROUP BY 1;
```

### 4.5 How long subscribers take to reply (for tuning idle limits)

Gap between one menu and the next message in the same session. Heavy:
keep it to a day or two.

```sql
WITH legs AS (
  SELECT operator_name,
         extract(epoch FROM ts - lag(ts) OVER (
           PARTITION BY operator_name, session_id ORDER BY ts)) AS gap_s
    FROM ussd_session_logs
   WHERE ts >= now() - interval '2 days'
     AND direction IN ('response', 'async_outbound')
)
SELECT operator_name,
       count(*)                                                             AS replies,
       round(percentile_cont(0.95)  WITHIN GROUP (ORDER BY gap_s)::numeric, 1) AS p95_s,
       round(percentile_cont(0.999) WITHIN GROUP (ORDER BY gap_s)::numeric, 1) AS p999_s,
       round(max(gap_s)::numeric, 1)                                         AS max_s,
       count(*) FILTER (WHERE gap_s > 60)                                    AS over_60s
  FROM legs
 WHERE gap_s IS NOT NULL AND gap_s < 600
 GROUP BY 1
 ORDER BY 1;
```

---

## 5. Traffic and billing

### 5.1 Sessions per hour today, per network (live)

```sql
SELECT date_trunc('hour', ts AT TIME ZONE 'Africa/Dar_es_Salaam') AS hour_eat,
       operator_name,
       count(DISTINCT session_id) AS sessions,
       count(DISTINCT msisdn)     AS subscribers
  FROM ussd_session_logs
 WHERE ts >= date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam')
             AT TIME ZONE 'Africa/Dar_es_Salaam'
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

### 5.2 Daily totals per network for a date range (fast, from the summary)

Same numbers as the dashboard Summary page. Covers up to yesterday.

```sql
SELECT d.date, o.name AS operator,
       sum(d.sessions)       AS sessions,
       sum(d.legs)           AS legs,
       sum(d.errors)         AS sessions_with_error,
       sum(d.billable_units) AS billable_units
  FROM daily_session_summary d
  JOIN operators o ON o.id = d.operator_id
 WHERE d.date BETWEEN '2026-10-01' AND '2026-10-20'   -- ← change
 GROUP BY 1, 2
 ORDER BY 1 DESC, 2;
```

### 5.3 One shortcode's month, for an owner's invoice query

```sql
SELECT d.date, o.name AS operator, s.code,
       d.sessions, d.legs, d.billable_units
  FROM daily_session_summary d
  JOIN operators  o ON o.id = d.operator_id
  JOIN shortcodes s ON s.id = d.shortcode_id
 WHERE s.code = '*147*03#'                          -- ← change
   AND d.date >= date '2026-10-01'                  -- ← change
   AND d.date <  date '2026-11-01'                  -- ← change
 ORDER BY d.date, o.name;
```

`billable_units` is the session count described in 5.4: one per
started billing window on networks that have one, one per session on
networks that don't.

### 5.4 Every session of one shortcode in a month, with session counts

One row per session: who, which network, when it started and ended,
how long it lasted, and how many sessions it counts as on that network.
Use it when an owner disputes an invoice or wants the detail behind
5.3.

**Session counts** follow the network's billing window, which is
`operators.billable_window_secs`. A session counts one per started
window: with Vodacom's 20s window, 0–20s = 1, 21–40s = 2, 41–60s = 3.
The duration is rounded up to a whole second first, so 20.2s counts 2.
A network with no window counts every session as 1.

The windows as first configured: Vodacom 20s, Airtel 30s, Tigo 30s,
Halotel none. An admin can change them on the dashboard's Operators
page, so check the live values:

```sql
SELECT name, billable_window_secs FROM operators ORDER BY name;
```

```sql
WITH legs AS (
  SELECT l.session_id, l.operator_name, l.msisdn, l.ts
    FROM ussd_session_logs l
   WHERE l.shortcode_id IN (SELECT id FROM shortcodes
                             WHERE code = '*147*03#'                  -- ← change
                               AND environment = 'production')
     AND l.ts >= timestamp '2026-10-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (month start, EAT)
     AND l.ts <  timestamp '2026-11-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (next month, EAT)
     -- Leave out the gateway's own idle-expiry row: it is written when
     -- the sweep runs, up to the idle limit after the subscriber's last
     -- key press, and would stretch the session past its real end.
     AND l.raw_request_payload->>'_source' IS DISTINCT FROM 'gateway_session_expiry'
),
sessions AS (
  SELECT session_id, operator_name,
         max(msisdn)                                         AS msisdn,
         min(ts)                                             AS started,
         max(ts)                                             AS ended,
         ceil(extract(epoch FROM max(ts) - min(ts)))::int    AS duration_s,
         count(*)                                            AS legs
    FROM legs
   GROUP BY session_id, operator_name
)
SELECT s.msisdn,
       s.session_id,
       s.operator_name                                   AS network,
       s.started AT TIME ZONE 'Africa/Dar_es_Salaam'     AS start_eat,
       s.ended   AT TIME ZONE 'Africa/Dar_es_Salaam'     AS end_eat,
       s.duration_s,
       s.legs,
       o.billable_window_secs                            AS window_s,
       CASE WHEN o.billable_window_secs IS NOT NULL
            THEN greatest(1, ceil(s.duration_s::float8 / o.billable_window_secs))::int
            ELSE 1
       END                                               AS session_count
  FROM sessions s
  JOIN operators o ON o.name = s.operator_name
 ORDER BY s.started;
```

Totals for the same shortcode and month, per network. Use the same
three `-- ← change` values:

```sql
WITH legs AS (
  SELECT l.session_id, l.operator_name, l.msisdn, l.ts
    FROM ussd_session_logs l
   WHERE l.shortcode_id IN (SELECT id FROM shortcodes
                             WHERE code = '*147*03#'                  -- ← change
                               AND environment = 'production')
     AND l.ts >= timestamp '2026-10-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change
     AND l.ts <  timestamp '2026-11-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change
     AND l.raw_request_payload->>'_source' IS DISTINCT FROM 'gateway_session_expiry'
),
sessions AS (
  SELECT session_id, operator_name,
         max(msisdn)                                      AS msisdn,
         ceil(extract(epoch FROM max(ts) - min(ts)))::int AS duration_s
    FROM legs
   GROUP BY session_id, operator_name
)
SELECT s.operator_name                                   AS network,
       count(*)                                          AS unique_sessions,
       count(DISTINCT s.msisdn)                          AS subscribers,
       sum(s.duration_s)                                 AS total_duration_s,
       round(avg(s.duration_s))                          AS avg_duration_s,
       sum(CASE WHEN o.billable_window_secs IS NOT NULL
                THEN greatest(1, ceil(s.duration_s::float8 / o.billable_window_secs))::int
                ELSE 1 END)                              AS session_counts
  FROM sessions s
  JOIN operators o ON o.name = s.operator_name
 GROUP BY s.operator_name
 ORDER BY s.operator_name;
```

Notes:
- **Why these may differ from the dashboard.** The dashboard Sessions
  page and Summary still include the gateway's idle-expiry row, so for
  sessions that ended by expiry they show a longer duration and can
  show a higher session count. These queries use the subscriber's last
  real message as the end.
- **Month boundaries are Tanzania time.** The rare session that runs
  across midnight at the month end is split: each month counts only the
  part that falls inside it.
- **Vodacom reuses session ids** over long periods. Within one month
  this is rare, but a session showing an implausibly long duration is
  usually two sessions sharing an id.
- **How long it takes.** Both queries read only the month's
  partitions, through the `(shortcode_id, ts)` index. Measured on a
  test database: about 1.5–2.5 s for a shortcode with 90,000 sessions
  (360,000 legs) in the month, and the time grows roughly in step with
  the shortcode's traffic. Most of it is reading the rows themselves,
  so raising `work_mem` barely helps. For a very busy shortcode, run
  it outside peak hours, or one week at a time, and raise the timeout
  for that session with `SET statement_timeout = '5min';`. If you only
  need the monthly total and not the per-session rows, 5.3 is instant.
- **Exporting for the owner:** in `psql`, wrap the first query as
  `\copy ( … ) TO 'sessions_147_03_2026_10.csv' CSV HEADER`, with the
  query on one line inside the brackets and no trailing semicolon.

### 5.5 Busiest shortcodes yesterday

```sql
SELECT o.name AS operator, coalesce(s.code, 'unmatched') AS shortcode,
       s.label, d.sessions, d.billable_units
  FROM daily_session_summary d
  JOIN operators o ON o.id = d.operator_id
  LEFT JOIN shortcodes s ON s.id = d.shortcode_id
 WHERE d.date = current_date - 1
 ORDER BY d.sessions DESC
 LIMIT 20;
```

### 5.6 Very short sessions (5 seconds or less) in a month

Sessions that lasted 5 seconds or less from first to last message. A
session with one message has a duration of 0. Many of these are
normal: a subscriber who dials, reads the menu and walks away is a
one-message session. A shortcode or network whose share suddenly jumps
usually means its first menu is failing or ending straight away.

Set the month in the two time conditions of each query: the first
day of the month and the first day of the next month, in Tanzania
time. The examples cover September 2026. For the last 30 days
instead, replace both time conditions with
`ts >= now() - interval '30 days'`.

These read a whole month of traffic. Run the summary first, then list
sessions for the shortcode that stands out, using its filter.

**Summary per network and shortcode:**

Subscribers sometimes type more after the code, such as
`*147*03#0755953306#`, and the network sends the whole string as the
service code. The summary counts these under the code they started
with (`*147*03#`) and shows how many there were in `extra_digits`.
When a code's short sessions are mostly `extra_digits`, the dial
string is the cause, not the application.

```sql
WITH sessions AS (
  SELECT session_id, operator_name,
         max(service_code) FILTER (WHERE service_code <> '') AS dialled,
         count(*)                                             AS legs,
         extract(epoch FROM max(ts) - min(ts))                AS duration_s
    FROM ussd_session_logs
   WHERE ts >= timestamp '2026-09-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (month start, EAT)
     AND ts <  timestamp '2026-10-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (next month, EAT)
     -- The gateway's idle-expiry row is not subscriber activity.
     AND raw_request_payload->>'_source' IS DISTINCT FROM 'gateway_session_expiry'
   GROUP BY session_id, operator_name
),
coded AS (
  -- Everything up to the first '#' is the code dialled; the rest is extra.
  SELECT *, substring(dialled FROM '^[^#]*#') AS shortcode
    FROM sessions
)
SELECT operator_name                                      AS network,
       coalesce(shortcode, '(unknown)')                   AS shortcode,
       count(*)                                           AS sessions,
       count(*) FILTER (WHERE duration_s <= 5)            AS short_sessions,
       count(*) FILTER (WHERE duration_s <= 5 AND legs = 1) AS one_message_only,
       count(*) FILTER (WHERE duration_s <= 5
                          AND dialled <> shortcode)       AS extra_digits,
       round(100.0 * count(*) FILTER (WHERE duration_s <= 5)
             / count(*), 1)                               AS short_pct
  FROM coded
 GROUP BY 1, 2
HAVING count(*) FILTER (WHERE duration_s <= 5) > 0
 ORDER BY short_sessions DESC;
```

To see what was typed after the code, list the `extra_digits`
sessions:

```sql
SELECT operator_name AS network, service_code AS dialled,
       count(DISTINCT session_id) AS sessions
  FROM ussd_session_logs
 WHERE ts >= timestamp '2026-09-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (month start, EAT)
   AND ts <  timestamp '2026-10-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (next month, EAT)
   AND service_code ~ '#.'
 GROUP BY 1, 2
 ORDER BY 3 DESC;
```

**The sessions themselves**, with what the subscriber last saw:

```sql
WITH legs AS (
  SELECT session_id, operator_name, service_code, msisdn, ts,
         coalesce(error_class, handler_response_action, handler_response_text) AS status,
         left(handler_response_text, 60)                                    AS reply
    FROM ussd_session_logs
   WHERE ts >= timestamp '2026-09-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (month start, EAT)
     AND ts <  timestamp '2026-10-01 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (next month, EAT)
     AND raw_request_payload->>'_source' IS DISTINCT FROM 'gateway_session_expiry'
     -- Strongly recommended: narrow to one shortcode and/or network.
     AND shortcode_id IN (SELECT id FROM shortcodes WHERE code = '*147*03#')   -- ← change, or delete the line
     -- AND operator_name = 'vodacom'                                          -- ← optional
),
sessions AS (
  SELECT session_id, operator_name,
         max(service_code) FILTER (WHERE service_code <> '')   AS shortcode,
         max(msisdn)                                           AS msisdn,
         min(ts)                                               AS started,
         max(ts)                                               AS ended,
         count(*)                                              AS legs,
         (array_agg(status ORDER BY ts DESC))[1]               AS last_status,
         (array_agg(reply  ORDER BY ts DESC))[1]               AS last_reply
    FROM legs
   GROUP BY session_id, operator_name
  HAVING max(ts) - min(ts) <= interval '5 seconds'
)
SELECT msisdn, session_id, operator_name AS network, shortcode,
       started AT TIME ZONE 'Africa/Dar_es_Salaam'          AS start_eat,
       ended   AT TIME ZONE 'Africa/Dar_es_Salaam'          AS end_eat,
       round(extract(epoch FROM ended - started)::numeric, 1) AS duration_s,
       legs, last_status, last_reply
  FROM sessions
 ORDER BY started
 LIMIT 1000;                                                -- ← raise, or remove for an export
```

`last_status` is the error class when there was one (for example
`shortcode_not_found`, `timeout`), otherwise `CON` or `END`.
`legs = 1` with `CON` means the subscriber saw the first menu and
never answered. `END` within a second or two means the application
ended the session on its first reply.

---

## 6. Is the gateway healthy?

### 6.1 Is traffic arriving from every network?

A network with an old `last_message_eat` during the day usually means
a connectivity problem on that network's side or the VPN.

```sql
SELECT o.name AS operator,
       last.ts AT TIME ZONE 'Africa/Dar_es_Salaam' AS last_message_eat,
       round(extract(epoch FROM now() - last.ts) / 60) AS minutes_ago
  FROM operators o
  LEFT JOIN LATERAL (
         SELECT max(l.ts) AS ts
           FROM ussd_session_logs l
          WHERE l.operator_id = o.id
            AND l.ts >= now() - interval '6 hours') last ON true
 ORDER BY o.name;
```

### 6.2 Open sessions the gateway is tracking

```sql
SELECT o.name AS operator,
       count(*)                                                        AS open_sessions,
       count(*) FILTER (WHERE a.last_seen_at < now() - interval '1 hour') AS stale_over_1h,
       min(a.last_seen_at) AT TIME ZONE 'Africa/Dar_es_Salaam'         AS oldest_eat
  FROM ussd_active_sessions a
  JOIN operators o ON o.id = a.operator_id
 GROUP BY 1
 ORDER BY 1;
```

`stale_over_1h` should stay near zero: the gateway expires idle sessions
within minutes and a scheduled clean-up removes anything left after an
hour.

### 6.3 Are the summary tables up to date?

```sql
SELECT 'daily_session_summary' AS source, max(date)::text AS covers_up_to,
       max(updated_at) AT TIME ZONE 'Africa/Dar_es_Salaam' AS refreshed_eat
  FROM daily_session_summary
UNION ALL
SELECT 'today_session_summary_mv', max(date)::text, NULL
  FROM today_session_summary_mv;
```

`daily_session_summary` should cover yesterday. If it doesn't, the
nightly scheduler did not run: check `docker compose logs scheduler`.

### 6.4 Storage partitions are prepared ahead

The newest partitions should reach at least two weeks into the future,
and the default partition should hold no rows.

```sql
SELECT c.relname AS partition,
       pg_get_expr(c.relpartbound, c.oid) AS covers
  FROM pg_inherits i
  JOIN pg_class    c ON c.oid = i.inhrelid
 WHERE i.inhparent = 'ussd_session_logs'::regclass
   AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
 ORDER BY pg_get_expr(c.relpartbound, c.oid) DESC   -- newest range first
 LIMIT 5;

SELECT count(*) AS rows_in_default_partition
  FROM ussd_session_logs_default;
```

---

## 7. Dashboard users and access

### 7.1 Dashboard accounts and when they last logged in

```sql
SELECT u.id, u.name, u.email, r.key AS role, u.active,
       u.last_login AT TIME ZONE 'Africa/Dar_es_Salaam' AS last_login_eat
  FROM portal_users u
  JOIN roles r ON r.id = u.role_id
 ORDER BY u.last_login DESC NULLS LAST;
```

### 7.2 Who can see a shortcode's data

```sql
SELECT 'owner' AS access, u.name, u.email
  FROM shortcodes s
  JOIN portal_users u ON u.id = s.owner_user_id
 WHERE s.code = '*147*04#'                          -- ← change
UNION ALL
SELECT 'viewer (' || g.access_level || ')', u.name, u.email
  FROM shortcodes s
  JOIN portal_user_shortcodes g ON g.shortcode_id = s.id
  JOIN portal_users u           ON u.id = g.portal_user_id
 WHERE s.code = '*147*04#';                         -- ← change
```

### 7.3 Changes made to a shortcode in the dashboard

```sql
SELECT a.ts AT TIME ZONE 'Africa/Dar_es_Salaam' AS time_eat,
       a.actor, a.action, a.outcome, a.detail
  FROM portal_audit_log a
 WHERE a.action LIKE 'shortcode.%'
   AND a.ts >= now() - interval '30 days'
   AND (a.target IN (SELECT id::text FROM shortcodes WHERE code = '*147*04#')   -- ← change
        OR a.target LIKE '%:*147*04#')                                          -- ← change
 ORDER BY a.ts DESC;
```

### 7.4 Failed dashboard logins (possible lockouts or guessing)

```sql
SELECT a.actor, count(*) AS failures,
       max(a.ts) AT TIME ZONE 'Africa/Dar_es_Salaam' AS last_attempt_eat,
       string_agg(DISTINCT a.ip, ', ') AS from_ips
  FROM portal_audit_log a
 WHERE a.action = 'auth.login'
   AND a.outcome IN ('failure', 'denied')
   AND a.ts >= now() - interval '24 hours'
 GROUP BY 1
 ORDER BY 2 DESC;
```

---

## 8. Older than 120 days (archive)

Rows older than 120 days are in `ussd_session_logs_archive`. It has
the same columns but **no indexes**, so a narrow time window is
essential: keep it to a day or less.

```sql
SELECT ts AT TIME ZONE 'Africa/Dar_es_Salaam' AS time_eat,
       operator_name, service_code, session_id, direction,
       ussd_string, handler_response_action AS action,
       left(handler_response_text, 80) AS reply, error_class
  FROM ussd_session_logs_archive
 WHERE ts >= timestamp '2026-05-10 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (EAT)
   AND ts <  timestamp '2026-05-11 00:00' AT TIME ZONE 'Africa/Dar_es_Salaam'  -- ← change (EAT)
   AND msisdn = '255712345678'                                                 -- ← change
 ORDER BY ts;
```
