/**
 * Reads over `ussd_session_logs_archive` (db/026) — the cold partitions
 * detached from the live table when they pass retention.
 *
 * This is the ONLY module that touches the archive. Nothing here is
 * imported by the report/summary/overview paths, and nothing there
 * reaches in here: keeping the archive out of every hot query is what
 * makes it free, and a shared helper would be the first step toward
 * losing that.
 *
 * The archive has NO INDEXES by design (they were ~72% of a partition's
 * size, and dropping them is what made archiving cheap). The only access
 * strategy is therefore PARTITION PRUNING on ts, which means every query
 * here must carry a bounded date range — a search without one would seq
 * scan every archived week. That isn't a caller's responsibility to
 * remember, so the window is enforced below rather than documented.
 *
 * Everything runs on the REPORT pool: a seq scan of one archived week is
 * roughly a second, which belongs nowhere near the interactive pool that
 * serves page loads.
 */
import { query, reportQuery } from "./db";

/** Largest window a single archive search may span. */
export const ARCHIVE_MAX_WINDOW_DAYS = Number(
  process.env.DASHBOARD_ARCHIVE_MAX_WINDOW_DAYS || 7,
);

/** Hard cap on rows returned. Forensic lookups, not bulk extraction. */
export const ARCHIVE_ROW_CAP = 500;

export interface ArchiveCoverage {
  partitions: number;
  /** Oldest / newest instants held, or null when nothing is archived. */
  from: string | null;
  to: string | null;
  bytes: number;
  size: string;
}

/**
 * What the archive currently holds. Reads the inventory view from
 * db/026 — catalogue only, no table access, so it stays fast however
 * large the archive grows.
 */
export async function archiveCoverage(): Promise<ArchiveCoverage> {
  const r = await query<{
    partitions: string; from: string | null; to: string | null;
    bytes: string; size: string;
  }>(
    `SELECT COUNT(*)::text                              AS partitions,
            MIN(covers_from)::text                      AS from,
            MAX(covers_to)::text                        AS to,
            COALESCE(SUM(bytes), 0)::text               AS bytes,
            pg_size_pretty(COALESCE(SUM(bytes), 0))     AS size
       FROM ussd_session_log_archive_partitions`,
  );
  const row = r.rows[0];
  return {
    partitions: Number(row?.partitions ?? 0),
    from: row?.from ?? null,
    to: row?.to ?? null,
    bytes: Number(row?.bytes ?? 0),
    size: row?.size ?? "0 bytes",
  };
}

export interface ArchiveFilters {
  /** 'YYYY-MM-DD'. Both required — see the pruning note above. */
  fromDate: string;
  toDate: string;
  msisdn?: string;
  sessionId?: string;
  shortcodeId?: number;
  operatorName?: string;
}

export interface ArchiveRow {
  ts: string;
  operator_name: string;
  service_code: string | null;
  shortcode_id: number | null;
  msisdn: string | null;
  session_id: string;
  direction: string;
  ussd_string: string | null;
  handler_response_action: string | null;
  handler_response_text: string | null;
  error_class: string | null;
}

export interface ArchiveSearchResult {
  rows: ArchiveRow[];
  /** True when the row cap trimmed the result — the UI says so. */
  capped: boolean;
}

/**
 * Bounded search over archived legs.
 *
 * Throws on an out-of-range window rather than silently clamping: this
 * is an admin tool, and quietly returning a different range than the one
 * asked for is how someone concludes "there's nothing there" about data
 * that is in fact there.
 */
export async function searchArchive(
  f: ArchiveFilters,
): Promise<ArchiveSearchResult> {
  const spanDays =
    (Date.parse(`${f.toDate}T00:00:00Z`) - Date.parse(`${f.fromDate}T00:00:00Z`))
    / 86_400_000;
  if (!Number.isFinite(spanDays) || spanDays < 0) {
    throw new Error("invalid date range");
  }
  if (spanDays + 1 > ARCHIVE_MAX_WINDOW_DAYS) {
    throw new Error(
      `date range too wide — the archive is unindexed, so searches are ` +
      `limited to ${ARCHIVE_MAX_WINDOW_DAYS} days at a time`,
    );
  }

  const conds: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [];
  const next = (v: unknown) => { params.push(v); return `$${params.length}`; };

  // The pruning predicate. First, always, and never optional.
  conds.push(`ts >= ${next(f.fromDate)}::date`);
  conds.push(`ts <  (${next(f.toDate)}::date + interval '1 day')`);

  if (f.msisdn)       conds.push(`msisdn = ${next(f.msisdn)}`);
  if (f.sessionId)    conds.push(`session_id = ${next(f.sessionId)}`);
  if (f.shortcodeId)  conds.push(`shortcode_id = ${next(f.shortcodeId)}`);
  if (f.operatorName) conds.push(`operator_name = ${next(f.operatorName)}`);

  // Fetch one extra row to detect truncation without a second COUNT —
  // a COUNT here would double the scan for no new information.
  const r = await reportQuery<ArchiveRow>(
    `SELECT ts::text, operator_name, service_code, shortcode_id, msisdn,
            session_id, direction, ussd_string,
            handler_response_action, handler_response_text, error_class
       FROM ussd_session_logs_archive
      WHERE ${conds.join(" AND ")}
      ORDER BY ts DESC
      LIMIT ${ARCHIVE_ROW_CAP + 1}`,
    params,
  );
  const capped = r.rows.length > ARCHIVE_ROW_CAP;
  return { rows: capped ? r.rows.slice(0, ARCHIVE_ROW_CAP) : r.rows, capped };
}
