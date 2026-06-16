#!/usr/bin/env node
/**
 * Async export worker. Polls portal_exports for queued jobs, claims
 * one with FOR UPDATE SKIP LOCKED, streams the matching rows to a
 * CSV in /exports, and flips status to 'ready' (or 'failed').
 *
 * Runs in its own container (ussd-exports-worker) so heavy jobs
 * don't starve the Next.js request loop. Same Postgres conn config
 * as the dashboard (USSD_PG_* env).
 *
 * Pagination: chunked LIMIT/OFFSET in 10k-row windows. With migration
 * 004 partitioning by ts + the default 24h filter, the WHERE pruner
 * keeps these on ONE partition so OFFSET stays cheap.
 *
 * CSV escaping: standard RFC 4180-ish — wrap in quotes when the value
 * contains a comma, quote, or newline; embedded quotes are doubled.
 */
import { createWriteStream, mkdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;

const PG = {
  host:     process.env.USSD_PG_HOST     || "127.0.0.1",
  port:     Number(process.env.USSD_PG_PORT || 5432),
  user:     process.env.USSD_PG_USER     || "ussd_gw",
  password: process.env.USSD_PG_PASSWORD || "",
  database: process.env.USSD_PG_DB       || "ussd_gateway_tz",
  ssl:      ({ disable: false, require: { rejectUnauthorized: false } }[(process.env.USSD_PG_SSLMODE || "prefer").toLowerCase()] ?? undefined),
  application_name: "ussd_exports_worker",
};

const EXPORTS_DIR = resolve(process.env.EXPORTS_DIR || "/exports");
const POLL_INTERVAL_MS = Number(process.env.EXPORTS_POLL_INTERVAL_MS || 3000);
const CHUNK = Number(process.env.EXPORTS_CHUNK_SIZE || 10_000);
// Maintenance — zombie reaper + retention sweeper. Both run on the
// same cadence (default every 60s) since each is a single cheap
// query plus a small file unlink loop. Defaults are tuned for the
// "dev / single tenant" baseline; bump in compose env for prod.
const REAP_AFTER_SECONDS      = Number(process.env.EXPORTS_REAP_AFTER_SECONDS      || 600);    // 10 min
const RETENTION_DAYS          = Number(process.env.EXPORTS_RETENTION_DAYS          || 7);
const MAINTENANCE_INTERVAL_MS = Number(process.env.EXPORTS_MAINTENANCE_INTERVAL_MS || 60_000); // 60s

mkdirSync(EXPORTS_DIR, { recursive: true });

const pool = new Pool(PG);

// Graceful shutdown so an in-flight job marks itself failed rather
// than leaving a 'running' row stuck after a container restart.
let shutdown = false;
let currentJobId = null;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    shutdown = true;
    console.log(`[exports-worker] ${sig} received; stopping after current job (id=${currentJobId})`);
  });
}

/* ---------- CSV escape ----------------------------------------- */

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function csvLine(values) {
  return values.map(csvCell).join(",") + "\n";
}

/* ---------- query builders for the two granularities ----------- */

const LEG_COLUMNS = [
  "ts",
  "operator_name",
  "shortcode_code",
  "msisdn",
  "session_id",
  "direction",
  "handler_response_action",
  "error_class",
  "handler_elapsed_ms",
  "ussd_string",
  "handler_response_text",
];
const SESSION_COLUMNS = [
  "session_id",
  "operator_name",
  "shortcode_code",
  "msisdn",
  "first_ts",
  "last_ts",
  "duration_secs",
  "leg_count",
  "final_action",
  "final_error_class",
  "billable_window_secs",
  "billable_units",
];

/**
 * Build the WHERE clause from a filters object — mirrors
 * dashboard/src/lib/reports.ts buildWhere(). The shortcode allowlist
 * baked into the filter at enqueue time enforces per-row access
 * across the async boundary.
 */
function buildWhere(filters) {
  const conds = [];
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };

  // Per-row access control.
  const allow = filters.allowedShortcodeIds;
  if (allow !== null && allow !== undefined) {
    if (!Array.isArray(allow) || allow.length === 0) {
      conds.push("FALSE");
    } else {
      conds.push(`shortcode_id = ANY(${push(allow)}::int[])`);
    }
  }

  if (filters.from) conds.push(`ts >= ${push(filters.from)}::timestamptz`);
  if (filters.to)   conds.push(`ts <  (${push(filters.to)}::date + interval '1 day')`);
  if (filters.msisdn) conds.push(`msisdn = ${push(filters.msisdn)}`);
  if (filters.session_id) conds.push(`session_id = ${push(filters.session_id)}`);
  if (Array.isArray(filters.operators) && filters.operators.length) {
    conds.push(`operator_name = ANY(${push(filters.operators)}::text[])`);
  }
  if (Array.isArray(filters.shortcodeIds) && filters.shortcodeIds.length) {
    conds.push(`shortcode_id = ANY(${push(filters.shortcodeIds)}::int[])`);
  }
  const ec = filters.error_class;
  if (ec === "ok")      conds.push(`error_class IS NULL`);
  else if (ec === "error") conds.push(`error_class IS NOT NULL`);
  else if (ec && ec !== "any") conds.push(`error_class = ${push(ec)}`);

  return { sql: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", params };
}

function legsQuery(where, offset, limit) {
  return {
    text: `
      SELECT l.ts::text AS ts,
             l.operator_name,
             -- Prefer the configured shortcode label; fall back to the
             -- dialed service_code so 'shortcode_not_found' rows still
             -- show what the customer dialed instead of a blank cell.
             COALESCE(s.code, l.service_code) AS shortcode_code,
             l.msisdn, l.session_id, l.direction,
             l.handler_response_action,
             l.error_class, l.handler_elapsed_ms,
             l.ussd_string, l.handler_response_text
        FROM ussd_session_logs l
   LEFT JOIN shortcodes s ON s.id = l.shortcode_id
        ${where.sql}
    ORDER BY l.ts DESC, l.id DESC
       LIMIT ${limit} OFFSET ${offset}
    `,
    values: where.params,
  };
}

function sessionsQuery(where, offset, limit) {
  // Reuses the grouped CTE shape from lib/reports.ts loadSessionPage.
  return {
    text: `
      WITH grouped AS (
        SELECT
          session_id,
          operator_name,
          (array_agg(shortcode_id) FILTER (WHERE shortcode_id IS NOT NULL))[1] AS shortcode_id,
          -- Carry the dialed service_code through so the outer SELECT
          -- can fall back to it when the shortcodes JOIN misses (the
          -- 'shortcode_not_found' case). Mirror of the lib/reports.ts
          -- loadSessionPage CTE.
          (array_agg(service_code  ORDER BY ts DESC NULLS LAST))[1] AS service_code,
          (array_agg(msisdn)       FILTER (WHERE msisdn       IS NOT NULL))[1] AS msisdn,
          MIN(ts) AS first_ts,
          MAX(ts) AS last_ts,
          EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts)))::float8 AS duration_secs,
          COUNT(*) AS leg_count,
          (array_agg(handler_response_action ORDER BY ts DESC NULLS LAST))[1] AS final_action,
          (array_agg(error_class             ORDER BY ts DESC NULLS LAST))[1] AS final_error_class
          FROM ussd_session_logs l${where.sql}
          GROUP BY session_id, operator_name
      )
      SELECT g.session_id, g.operator_name,
             COALESCE(s.code, g.service_code) AS shortcode_code,
             g.msisdn,
             g.first_ts::text, g.last_ts::text,
             g.duration_secs, g.leg_count::int,
             g.final_action, g.final_error_class,
             o.billable_window_secs,
             CASE WHEN o.billable_window_secs IS NOT NULL
                  THEN GREATEST(1, CEIL(g.duration_secs / o.billable_window_secs::float8))::int
                  ELSE NULL END AS billable_units
        FROM grouped g
   LEFT JOIN shortcodes s ON s.id = g.shortcode_id
   LEFT JOIN operators  o ON o.name = g.operator_name
    ORDER BY g.last_ts DESC, g.session_id DESC
       LIMIT ${limit} OFFSET ${offset}
    `,
    values: where.params,
  };
}

/* ---------- job lifecycle -------------------------------------- */

async function claimOne(client) {
  // FOR UPDATE SKIP LOCKED lets multiple workers run concurrently
  // without stepping on each other.
  const r = await client.query(`
    SELECT id, user_id, granularity, filters
      FROM portal_exports
     WHERE status = 'queued'
     ORDER BY id
     LIMIT 1
       FOR UPDATE SKIP LOCKED
  `);
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  await client.query(
    `UPDATE portal_exports
        SET status = 'running', started_at = now()
      WHERE id = $1`,
    [row.id],
  );
  return row;
}

async function finalize(client, id, { filePath, rowCount, sizeBytes }) {
  await client.query(
    `UPDATE portal_exports
        SET status = 'ready',
            completed_at = now(),
            file_path = $2,
            row_count = $3,
            file_size_bytes = $4
      WHERE id = $1`,
    [id, filePath, rowCount, sizeBytes],
  );
}

async function failJob(pool, id, errMsg) {
  try {
    await pool.query(
      `UPDATE portal_exports
          SET status = 'failed',
              completed_at = now(),
              error_message = $2
        WHERE id = $1`,
      [id, String(errMsg).slice(0, 2000)],
    );
  } catch (e) {
    console.error(`[exports-worker] failed to mark job ${id} failed:`, e);
  }
}

/* ---------- maintenance --------------------------------------- */

/**
 * Zombie reaper: any row stuck in `running` for longer than
 * REAP_AFTER_SECONDS means the worker that claimed it died without
 * marking it failed (OOM, kill -9, crash before the error listener
 * fix landed, etc.). Reset to `queued` so another claim picks it up.
 *
 * Resetting (vs marking failed) is the right move because the
 * underlying work was never actually attempted to completion —
 * the user still wants their CSV.
 */
async function reapZombies() {
  const r = await pool.query(
    `UPDATE portal_exports
        SET status = 'queued', started_at = NULL
      WHERE status = 'running'
        AND started_at < now() - ($1 || ' seconds')::interval`,
    [String(REAP_AFTER_SECONDS)],
  );
  if (r.rowCount) {
    console.log(`[exports-worker] reaped ${r.rowCount} stale 'running' row(s)`);
  }
}

/**
 * Retention sweep: CSVs older than RETENTION_DAYS get their file
 * unlinked from /exports and the row flipped to `expired` (file_path
 * cleared, size kept for accounting). The /exports UI shows
 * "retention" instead of a Download link for expired rows.
 *
 * Iterates the candidate set in PG-order and stops at a reasonable
 * batch size (1k) so a long-stalled sweeper doesn't lock everything
 * up on first run after a long downtime.
 */
async function sweepRetention() {
  const r = await pool.query(
    `SELECT id, file_path
       FROM portal_exports
      WHERE status = 'ready'
        AND completed_at < now() - ($1 || ' days')::interval
        AND file_path IS NOT NULL
      ORDER BY id
      LIMIT 1000`,
    [String(RETENTION_DAYS)],
  );
  if (r.rowCount === 0) return;
  let expired = 0;
  for (const row of r.rows) {
    try { unlinkSync(row.file_path); } catch (e) {
      // Treat missing files as already-swept; log unexpected errors.
      if (e?.code !== "ENOENT") {
        console.warn(`[exports-worker] retention unlink ${row.file_path} failed:`, e?.message || e);
      }
    }
    try {
      await pool.query(
        `UPDATE portal_exports
            SET status = 'expired', file_path = NULL
          WHERE id = $1`,
        [row.id],
      );
      expired++;
    } catch (e) {
      console.warn(`[exports-worker] retention update id=${row.id} failed:`, e?.message || e);
    }
  }
  console.log(`[exports-worker] retention swept ${expired} row(s)`);
}

/** Combined maintenance tick. Wrapped in try/catch + an in-flight
 *  guard so overlapping ticks (slow sweep, fast interval) don't
 *  stack — the next tick is silently skipped. */
let maintenanceInFlight = false;
async function maintenanceTick() {
  if (maintenanceInFlight) return;
  maintenanceInFlight = true;
  try {
    await reapZombies();
    await sweepRetention();
  } catch (e) {
    console.error("[exports-worker] maintenance error:", e);
  } finally {
    maintenanceInFlight = false;
  }
}

async function processJob(client, job) {
  const filters = job.filters || {};
  const where = buildWhere(filters);
  const filePath = `${EXPORTS_DIR}/export_${job.id}.csv`;
  const sink = createWriteStream(filePath);

  // Attach an error listener IMMEDIATELY. WriteStream emits 'error'
  // asynchronously (e.g. on EACCES at open time); without a listener
  // Node throws the error event, crashing the worker before any
  // try/catch upstream sees it. We turn that into a Promise rejection
  // we can await alongside finish.
  const sinkClosed = new Promise((resolve, reject) => {
    sink.on("error", reject);
    sink.on("finish", resolve);
  });

  // Stream header
  const cols = job.granularity === "sessions" ? SESSION_COLUMNS : LEG_COLUMNS;

  let offset = 0;
  let total  = 0;
  try {
    sink.write(csvLine(cols));
    // For 'sessions' granularity, we re-run the grouped CTE each
    // chunk. Repeated work is OK at 10k chunks; for very wide
    // exports a single cursor would be tighter — defer that micro-
    // opt until row counts make it actually matter.
    while (!shutdown) {
      const q = job.granularity === "sessions"
        ? sessionsQuery(where, offset, CHUNK)
        : legsQuery(where, offset, CHUNK);
      const { rows } = await client.query(q);
      if (rows.length === 0) break;
      for (const row of rows) {
        const values = cols.map((c) => row[c]);
        sink.write(csvLine(values));
      }
      total += rows.length;
      offset += CHUNK;
      if (rows.length < CHUNK) break;
    }
    sink.end();
    await sinkClosed;
  } catch (e) {
    try { sink.destroy(); } catch {}
    // Re-throw so the tick() loop's catch marks the job failed.
    throw e;
  }

  const size = statSync(filePath).size;
  await finalize(client, job.id, { filePath, rowCount: total, sizeBytes: size });
  console.log(`[exports-worker] export ${job.id} ready: ${total} rows, ${size} bytes`);
}

/* ---------- main loop ------------------------------------------ */

async function tick() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await claimOne(client);
    if (!job) { await client.query("ROLLBACK"); return false; }
    await client.query("COMMIT");
    currentJobId = job.id;
    console.log(`[exports-worker] claimed export ${job.id} (granularity=${job.granularity})`);
    try {
      // Each chunk runs in its own implicit transaction (client is
      // fresh outside the claim txn). On error, mark the row failed.
      await processJob(client, job);
    } catch (e) {
      console.error(`[exports-worker] job ${job.id} crashed:`, e);
      await failJob(pool, job.id, e?.message || String(e));
    }
    currentJobId = null;
    return true;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[exports-worker] tick error:", e);
    return false;
  } finally {
    client.release();
  }
}

console.log(
  `[exports-worker] starting; dir=${EXPORTS_DIR} pg=${PG.host}:${PG.port}/${PG.database} ` +
  `reap_after=${REAP_AFTER_SECONDS}s retention=${RETENTION_DAYS}d ` +
  `maintenance_every=${MAINTENANCE_INTERVAL_MS}ms`
);

// Maintenance ticker runs on its own cadence so a slow sweep can't
// stall job polling, and a busy polling loop can't starve reaping.
// fire-and-forget — maintenanceTick guards against overlap itself.
const maintenanceTimer = setInterval(() => { void maintenanceTick(); }, MAINTENANCE_INTERVAL_MS);
// Run one immediately at startup so a freshly-deployed worker
// reaps zombies left by its predecessor without waiting a full
// interval first.
void maintenanceTick();

(async () => {
  while (!shutdown) {
    let did;
    try {
      did = await tick();
    } catch (e) {
      console.error("[exports-worker] main loop error:", e);
      did = false;
    }
    if (!did) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  clearInterval(maintenanceTimer);
  await pool.end();
  console.log("[exports-worker] stopped cleanly");
  process.exit(0);
})();
