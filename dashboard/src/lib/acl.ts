/**
 * Per-row shortcode access control — the time-scoped allowlist.
 *
 * A user's access to a shortcode starts when the shortcode was
 * allocated to them (`shortcodes.owner_since`, or
 * `portal_user_shortcodes.granted_at` for a collaborator grant), not at
 * the beginning of time. Re-allocating a shortcode to a new client must
 * not hand them the previous client's traffic — MSISDNs, dialed
 * strings, volumes — so every report predicate carries a per-shortcode
 * time floor alongside the id.
 *
 * Shape:
 *   null            → unrestricted (super_admin / auditor, reports.view_all)
 *   []              → owns nothing; every query returns no rows
 *   [{id, from}]    → visible iff shortcode_id = id AND ts >= from
 *                     (`from` = 0 means "since forever")
 *
 * SQL generation groups the ids by their floor, so the common case —
 * every shortcode owned since it existed — emits exactly the predicate
 * this code used before time-scoping (`shortcode_id = ANY($n::int[])`)
 * and keeps the same query plans. Only a user who has actually been
 * handed someone else's shortcode pays for the extra OR-branch.
 */

import { ceilToLocalDate } from "./datetime";

/** One shortcode the caller may read, and from when. */
export interface ShortcodeGrant {
  id: number;
  /** Unix seconds; 0 = no lower bound. */
  from: number;
}

/** null = unrestricted. Otherwise an allowlist (possibly empty). */
export type ShortcodeAcl = ShortcodeGrant[] | null;

/** Just the ids — for callers that intersect with a user-picked filter. */
export function aclIds(acl: ShortcodeAcl): number[] | null {
  return acl === null ? null : acl.map((g) => g.id);
}

/** True when the ACL denies everything (caller owns no shortcodes). */
export function aclDeniesAll(acl: ShortcodeAcl): boolean {
  return acl !== null && acl.length === 0;
}

/** Narrow an ACL to a user-selected subset, keeping each floor. */
export function aclIntersect(acl: ShortcodeAcl, ids: number[]): ShortcodeAcl {
  if (!ids.length) return acl;
  if (acl === null) return ids.map((id) => ({ id, from: 0 }));
  const want = new Set(ids);
  return acl.filter((g) => want.has(g.id));
}

export interface AclClauseOpts {
  /** SQL expression for the shortcode id, e.g. "shortcode_id" or "d.shortcode_id". */
  scCol: string;
  /** SQL expression for the row's time, e.g. "ts" or "d.date". */
  tsCol: string;
  /**
   * Granularity of `tsCol`. "ts" compares against the exact hand-over
   * instant. "date" is for the pre-aggregated rollups, where a day is a
   * single row and cannot be split: a hand-over part-way through a day
   * moves the floor to the NEXT day, so the new owner never sees a
   * bucket containing the previous owner's traffic. They lose the tail
   * of the hand-over day in daily figures — visible in full on the
   * per-session pages, which are row-level.
   */
  grain: "ts" | "date";
  /** Push a parameter, get back its placeholder ("$3"). */
  push: (v: unknown) => string;
}

/**
 * The ACL predicate. Always returns a self-contained boolean expression
 * — "TRUE" when unrestricted, "FALSE" when the caller owns nothing —
 * so callers can drop it straight into a WHERE without special cases.
 */
export function aclClause(acl: ShortcodeAcl, o: AclClauseOpts): string {
  if (acl === null) return "TRUE";
  if (acl.length === 0) return "FALSE";

  // Group ids by their floor: users typically have one floor (0) or,
  // after a hand-over, two.
  const byFrom = new Map<number, number[]>();
  for (const g of acl) {
    const arr = byFrom.get(g.from);
    if (arr) arr.push(g.id);
    else byFrom.set(g.from, [g.id]);
  }

  const branches: string[] = [];
  for (const [from, ids] of byFrom) {
    const idsP = `${o.scCol} = ANY(${o.push(ids)}::int[])`;
    if (from <= 0) {
      branches.push(idsP);
      continue;
    }
    // The floor is a constant, so compute it here rather than in SQL: a
    // CASE over date_trunc() would be a stable expression the planner
    // can't fold, i.e. re-evaluated per row on the hot table.
    //
    // "ts" grain compares against the absolute instant — to_timestamp()
    // rather than an ISO string, so it can't be re-read in whatever
    // timezone the DB session happens to run in. "date" grain rounds up
    // to the first whole day the new owner is entitled to.
    const floor = o.grain === "ts"
      ? `to_timestamp(${o.push(from)})`
      : `${o.push(ceilToLocalDate(from))}::date`;
    branches.push(`(${idsP} AND ${o.tsCol} >= ${floor})`);
  }
  return branches.length === 1 ? branches[0]! : `(${branches.join(" OR ")})`;
}
