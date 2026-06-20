/**
 * Liveness probe for docker's healthcheck.
 *
 * Does a 1ms-cheap `SELECT 1` so a healthy response means BOTH:
 *   * Next.js is serving HTTP, and
 *   * the dashboard can round-trip to Postgres (catches the pool-
 *     exhaustion hang where Next.js is up but every query waits
 *     forever for a slot).
 *
 * Statement_timeout on the pool (30s default) bounds the worst case —
 * a failing probe returns 503 within seconds and docker's healthcheck
 * goes red. With `restart: unless-stopped` + retries=3 in compose,
 * the dashboard auto-replaces itself instead of hanging until you
 * notice and restart manually.
 */
import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await query("SELECT 1");
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("[/api/health] db probe failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
