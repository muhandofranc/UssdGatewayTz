/**
 * Timestamp formatting pinned to Tanzania time.
 *
 * Why this exists
 * ---------------
 * The DB stores `timestamptz` (absolute UTC + zone offset). pg-node
 * deserialises to a JS Date, which represents the correct absolute
 * moment — but native accessors like `d.getHours()` return the value
 * in the RUNNING PROCESS's local timezone. Inside a container that's
 * almost always UTC, so operators saw `13:48` instead of `16:48` for
 * the same absolute row.
 *
 * `Intl.DateTimeFormat` with `timeZone: 'Africa/Dar_es_Salaam'` gives
 * us the correct local wall-clock value regardless of where the
 * container runs (dev laptop, CI, prod host). Tanzania has no DST,
 * so the offset is a stable +03:00 all year.
 *
 * If we ever run this dashboard for a non-TZ tenant, expose DASHBOARD_TZ
 * as an env override — for now the project is Tanzania-only and
 * hard-coding is the honest signal.
 */

const TZ = "Africa/Dar_es_Salaam";

// `hourCycle: 'h23'` guarantees 00-23 (some browsers emit "24" for
// midnight under the plain `hour12: false` combo). `en-GB` is
// arbitrary — we rebuild the string via formatToParts so the locale's
// separator conventions don't leak through.
const _fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Format a DB timestamptz (or ISO string, or Date) as
 * `YYYY-MM-DD HH:MM:SS` in Tanzania time. Returns "—" for null/empty
 * and echoes the input unchanged if it isn't a parseable date.
 */
export function fmtTs(input: string | Date | null | undefined): string {
  if (input === null || input === undefined || input === "") return "—";
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return typeof input === "string" ? input : "—";
  const parts = _fmt.formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}


/**
 * The first whole day at or after `epochSeconds`, as 'YYYY-MM-DD' in
 * Tanzania time — the day boundary the rollups bucket by.
 *
 * Used for the ACL's time floor on day-grained tables (lib/acl.ts): a
 * hand-over at 14:30 makes the NEXT day the first one the new owner may
 * see, because the day it happened is a single row that also counts the
 * previous owner's traffic. A hand-over exactly at midnight needs no
 * rounding — that day is wholly theirs.
 */
export function ceilToLocalDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const parts = _fmt.formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";
  const day = `${g("year")}-${g("month")}-${g("day")}`;
  const midnight = g("hour") === "00" && g("minute") === "00" && g("second") === "00";
  if (midnight) return day;
  // Add a day in UTC on the plain date — no DST in EAT, so this is exact.
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
