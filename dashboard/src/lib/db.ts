/**
 * Postgres pool shared by all server-side code. The dashboard talks
 * to the SAME database as the gateway (same shortcodes, same
 * portal_users, same ussd_session_logs).
 *
 * Env mirrors the gateway's USSD_PG_* knobs so a single .env applies
 * cleanly to both services in docker-compose.
 */
import { Pool, type PoolConfig, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

function readPgConfig(): PoolConfig {
  const host = process.env.USSD_PG_HOST || "127.0.0.1";
  const port = Number(process.env.USSD_PG_PORT || 5432);
  const user = process.env.USSD_PG_USER || "ussd_gw";
  const password = process.env.USSD_PG_PASSWORD || "";
  const database = process.env.USSD_PG_DB || "ussd_gateway_tz";
  const sslmode = (process.env.USSD_PG_SSLMODE || "prefer").toLowerCase();
  const ssl =
    sslmode === "disable" ? false
    : sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full"
      ? { rejectUnauthorized: sslmode === "verify-full" }
      : undefined;
  // Timeouts deliberately tight enough that ONE slow query can't hold
  // a pool slot forever — that's the single most common cause of the
  // dashboard going "responsive then hung". Tune via env if a real
  // report needs a longer window.
  return {
    host, port, user, password, database, ssl,
    max: Number(process.env.DASHBOARD_PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Server-side kill — runaway queries get terminated by PG before
    // they monopolise a slot. Surfaces as a proper SQL error with
    // code = '57014', which page-level handlers can distinguish from
    // real bugs (see sessions/page.tsx → PG_STATEMENT_TIMEOUT).
    //
    // Client-side query_timeout is deliberately set LONGER than the
    // server-side statement_timeout — that ordering guarantees PG
    // always fires first, so the wide-filter recovery path in
    // page.tsx catches 57014 rather than pg-node's un-coded
    // "Query read timeout" (which would fall through to the App
    // Router's crash boundary and render as an ugly error page).
    // The 10 s buffer covers network RTT between the container and
    // the DB — bump both env vars in lockstep if you tune them.
    statement_timeout: Number(process.env.DASHBOARD_PG_STATEMENT_TIMEOUT_MS || 30_000),
    query_timeout:     Number(process.env.DASHBOARD_PG_QUERY_TIMEOUT_MS     || 40_000),
    // TCP keepalive — without this, a dead-but-not-FIN'd backend
    // (PG restart, NAT reaper, k8s pod recycle) leaves a "ghost"
    // connection in the pool that hangs forever until the OS-level
    // TCP timeout (often >2 hours). Keepalive surfaces it in seconds.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: "ussd_gw_dashboard",
  };
}

// One pool per process. Next.js dev mode HMR can re-import this
// module; cache the pool on globalThis to avoid leaking pools.
declare global { var __ussdDashPool: Pool | undefined; }
export const pool: Pool =
  globalThis.__ussdDashPool ?? (globalThis.__ussdDashPool = (() => {
    const p = new Pool(readPgConfig());
    // Surface idle-client errors so they don't crash the Node process.
    // pg-node's default for an unhandled `error` on the pool is to
    // emit "Unhandled 'error' event" → process.exit. We'd rather log
    // and let the pool drop the bad client and serve the next request
    // with a fresh one — same effect as docker restart but invisible.
    p.on("error", (err) => {
      console.error("[db.pool] idle client error:", err);
    });
    return p;
  })());

export async function query<T extends QueryResultRow = any>(
  text: string, params?: any[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withTx<T>(
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
