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
  return {
    host, port, user, password, database, ssl,
    max: Number(process.env.DASHBOARD_PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "ussd_gw_dashboard",
  };
}

// One pool per process. Next.js dev mode HMR can re-import this
// module; cache the pool on globalThis to avoid leaking pools.
declare global { var __ussdDashPool: Pool | undefined; }
export const pool: Pool =
  globalThis.__ussdDashPool ?? (globalThis.__ussdDashPool = new Pool(readPgConfig()));

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
