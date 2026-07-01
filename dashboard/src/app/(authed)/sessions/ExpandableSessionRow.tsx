/**
 * One session's summary row + lazy-mounted detail row holding the
 * per-leg breakdown. Client component because the chevron's open
 * state lives in React.
 *
 * Returns a Fragment of TWO <tr> siblings — React allows this so the
 * legs detail can occupy its own row spanning the full table width
 * (colSpan equal to the header column count, including the chevron).
 */
"use client";

import { useCallback, useState } from "react";
import type { SessionLeg, SessionRow } from "@/lib/reports";
import { fmtTs } from "@/lib/datetime";

const TOTAL_COLS = 12;   // chevron + 11 session-summary columns
type LegsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; legs: SessionLeg[] }
  | { kind: "error"; message: string };

/* -------- formatting helpers -------- */

function fmtDuration(input: number | string): string {
  const secs = Number(input);
  if (!Number.isFinite(secs)) return "—";
  if (secs < 1)  return `${secs.toFixed(2)}s`;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  if (secs < 60) return `${Math.round(secs)}s`;
  const total = Math.round(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function outcomeBadge(action: string | null, errorClass: string | null) {
  if (errorClass) {
    return (
      <span className="inline-flex items-center rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-1.5 py-0.5 text-xs font-mono">
        {errorClass}
      </span>
    );
  }
  if (action === "CON") {
    return (
      <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 text-xs font-mono">
        CON (open)
      </span>
    );
  }
  if (action === "END") {
    return (
      <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-xs font-mono">
        END
      </span>
    );
  }
  return <span className="text-xs text-slate-500">—</span>;
}

function legStatusBadge(action: string | null, errorClass: string | null) {
  return outcomeBadge(action, errorClass);
}

/* ----------------------------------------------------------- */

function LegsTable({ legs }: { legs: SessionLeg[] }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 overflow-hidden">
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-200 dark:border-slate-800">
        {legs.length} leg{legs.length === 1 ? "" : "s"}
      </div>
      <table className="min-w-full text-left">
        <thead className="bg-slate-100 dark:bg-slate-900">
          <tr>
            <th className="px-2 py-1 text-[11px] font-medium">Timestamp</th>
            <th className="px-2 py-1 text-[11px] font-medium">Dir</th>
            <th className="px-2 py-1 text-[11px] font-medium">MSISDN</th>
            <th className="px-2 py-1 text-[11px] font-medium">Status</th>
            <th className="px-2 py-1 text-[11px] font-medium">USSD trail</th>
            <th className="px-2 py-1 text-[11px] font-medium">Reply</th>
            <th className="px-2 py-1 text-[11px] font-medium text-right">ms</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.id} className="border-t border-slate-200 dark:border-slate-800">
              <td className="px-2 py-1 text-[11px] font-mono whitespace-nowrap">{fmtTs(l.ts)}</td>
              <td className="px-2 py-1 text-[11px] font-mono">{l.direction}</td>
              <td className="px-2 py-1 text-[11px] font-mono">{l.msisdn ?? "—"}</td>
              <td className="px-2 py-1">{legStatusBadge(l.handler_response_action, l.error_class)}</td>
              <td className="px-2 py-1 text-[11px] font-mono max-w-[14rem] truncate"
                  title={l.ussd_string ?? undefined}>
                {l.ussd_string || "—"}
              </td>
              <td className="px-2 py-1 text-[11px] font-mono max-w-[20rem] truncate"
                  title={l.handler_response_text ?? undefined}>
                {l.handler_response_text || "—"}
              </td>
              <td className="px-2 py-1 text-[11px] text-right tabular-nums">
                {l.handler_elapsed_ms !== null ? `${l.handler_elapsed_ms}ms` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ExpandableSessionRow({ row }: { row: SessionRow }) {
  const [open, setOpen] = useState(false);
  // Legs are LAZY — fetched via /api/sessions/legs the first time the
  // chevron opens. Cached on subsequent toggles so close/re-open is
  // instant. State machine keeps loading/error states explicit so the
  // UI never shows a blank panel.
  const [legsState, setLegsState] = useState<LegsState>({ kind: "idle" });

  const ensureLegsLoaded = useCallback(async () => {
    if (legsState.kind !== "idle") return;   // already loaded / loading / errored
    setLegsState({ kind: "loading" });
    try {
      // Send `first_ts` + `last_ts` so the backend can prune the
      // ts-partitioned scan (see loadLegsForSession comment). Without
      // these the query timed out at 30s on busy gateways.
      const url = `/api/sessions/legs?session_id=${encodeURIComponent(row.session_id)}`
                + `&operator=${encodeURIComponent(row.operator_name)}`
                + `&first_ts=${encodeURIComponent(row.first_ts)}`
                + `&last_ts=${encodeURIComponent(row.last_ts)}`;
      const resp = await fetch(url, { credentials: "same-origin" });
      if (!resp.ok) {
        setLegsState({ kind: "error", message: `HTTP ${resp.status}` });
        return;
      }
      const data = await resp.json() as { legs: SessionLeg[] };
      setLegsState({ kind: "ready", legs: Array.isArray(data.legs) ? data.legs : [] });
    } catch (e) {
      setLegsState({ kind: "error", message: (e as Error).message || "fetch failed" });
    }
  }, [legsState.kind, row.session_id, row.operator_name]);

  const toggle = () => {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen) void ensureLegsLoaded();
  };

  const truncatedSid = row.session_id.length > 22 ? row.session_id.slice(0, 22) + "…" : row.session_id;
  return (
    <>
      <tr
        className="border-t border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
        onClick={toggle}
      >
        <td className="px-2 py-1.5 text-xs">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggle(); }}
            aria-label={open ? "Collapse legs" : "Expand legs"}
            aria-expanded={open}
            className="w-5 h-5 inline-flex items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500"
          >
            <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
          </button>
        </td>
        <td className="px-2 py-1.5 text-xs font-mono">
          <span title={row.session_id}>{truncatedSid}</span>
        </td>
        <td className="px-2 py-1.5 text-xs font-mono">{row.operator_name}</td>
        <td className="px-2 py-1.5 text-xs font-mono">{row.shortcode_code ?? "—"}</td>
        <td className="px-2 py-1.5 text-xs font-mono">{row.msisdn ?? "—"}</td>
        <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap">{fmtTs(row.first_ts)}</td>
        <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap">{fmtTs(row.last_ts)}</td>
        <td className="px-2 py-1.5 text-xs text-right tabular-nums">
          <span title={`${Math.round(Number(row.duration_secs) * 1000)} ms`} className="font-mono">
            {fmtDuration(row.duration_secs)}
          </span>
        </td>
        <td className="px-2 py-1.5 text-xs text-right tabular-nums">{row.leg_count}</td>
        <td className="px-2 py-1.5">{outcomeBadge(row.final_action, row.final_error_class)}</td>
        <td className="px-2 py-1.5 text-xs font-mono max-w-[14rem] truncate"
            title={row.final_ussd_string ?? undefined}>
          {row.final_ussd_string || "—"}
        </td>
        <td className="px-2 py-1.5 text-xs text-right tabular-nums">
          {row.billable_units !== null
            ? <span
                className="font-mono"
                title={`${Number(row.duration_secs).toFixed(1)}s ÷ ${row.billable_window_secs}s window → CEIL = ${row.billable_units} session${row.billable_units === 1 ? "" : "s"}`}
              >
                {row.billable_units}
              </span>
            : <span className="text-slate-500" title="MNO bills per-leg, no duration window">—</span>}
        </td>
      </tr>
      {open ? (
        <tr className="bg-slate-50 dark:bg-slate-950/30">
          <td colSpan={TOTAL_COLS} className="px-2 py-2">
            {legsState.kind === "loading" ? (
              <div className="text-xs text-slate-500 px-3 py-3">Loading legs…</div>
            ) : legsState.kind === "error" ? (
              <div className="text-xs text-red-600 dark:text-red-300 px-3 py-3">
                Failed to load legs: {legsState.message}
              </div>
            ) : legsState.kind === "ready" ? (
              <LegsTable legs={legsState.legs} />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
