"use client";

/**
 * Interactive USSD handler simulator (client). Drives the USSD state
 * machine — START then INPUT legs, accumulating the `*`-joined trail —
 * and calls the `actionSimulateLeg` server action per leg. Renders the
 * handler's CON/END message as a phone screen and keeps a per-leg log
 * with the exact request/reply (raw view toggle).
 */
import { useState, useTransition } from "react";
import { actionSimulateLeg } from "./actions";
import type { SimShortcode, SimLegResult, SimEvent } from "@/lib/simulator";
// USSD handler simulator — client-driven state machine.

interface LegEntry {
  n: number;
  event: SimEvent;
  input: string;          // what the user "typed" for this leg ("" on start)
  result: SimLegResult;
}

const VERDICT_LABEL: Record<SimLegResult["verdict"], string> = {
  con: "CON — session continues",
  end: "END — session terminated",
  bad_action: "Bad reply — not CON/END",
  non2xx: "Handler HTTP error",
  timeout: "Handler timed out",
  transport: "Could not reach handler",
  not_allowed: "Not allowed",
  not_found: "Shortcode not found",
};

function genSessionId(): string {
  const rnd = (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, "");
  return `SIM-${rnd.slice(0, 12).toUpperCase()}`;
}

export default function Simulator({ shortcodes }: { shortcodes: SimShortcode[] }) {
  const [scId, setScId]       = useState<number>(shortcodes[0]?.id ?? 0);
  const [msisdn, setMsisdn]   = useState("255700000001");
  const [sessionId, setSessionId] = useState<string>("");
  const [ussdTrail, setUssdTrail] = useState<string>("");     // accumulated
  const [active, setActive]   = useState(false);              // session open (last reply CON)
  const [legs, setLegs]       = useState<LegEntry[]>([]);
  const [input, setInput]     = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [pending, startTransition] = useTransition();

  const sc = shortcodes.find((s) => s.id === scId) ?? shortcodes[0];
  const lastLeg = legs[legs.length - 1];
  const started = legs.length > 0;

  function reset() {
    setSessionId(""); setUssdTrail(""); setActive(false);
    setLegs([]); setInput("");
  }

  function runLeg(event: SimEvent, legInput: string, sid: string, trail: string) {
    startTransition(async () => {
      const result = await actionSimulateLeg({
        shortcodeId: scId, msisdn, sessionId: sid, event, ussdString: trail,
      });
      setLegs((prev) => [...prev, { n: prev.length + 1, event, input: legInput, result }]);
      setActive(result.verdict === "con");
      setInput("");
    });
  }

  function startSession() {
    const sid = genSessionId();
    setSessionId(sid);
    setUssdTrail("");
    setLegs([]);
    runLeg("start", "", sid, "");
  }

  function sendInput(e: React.FormEvent) {
    e.preventDefault();
    if (!active || pending) return;
    const trail = ussdTrail ? `${ussdTrail}*${input}` : input;
    setUssdTrail(trail);
    runLeg("input", input, sessionId, trail);
  }

  const screen = lastLeg
    ? (lastLeg.result.ok
        ? lastLeg.result.message ?? ""
        : `⚠ ${VERDICT_LABEL[lastLeg.result.verdict]}${lastLeg.result.detail ? `\n${lastLeg.result.detail}` : ""}`)
    : "Dial and press Start to begin.";

  return (
    <div className="grid md:grid-cols-[300px_1fr] gap-6">
      {/* ---------------- controls + phone ---------------- */}
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-400">Shortcode</span>
          <select
            value={scId}
            disabled={started}
            onChange={(e) => setScId(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5"
          >
            {shortcodes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.operator_name} · {s.code}{s.label ? ` (${s.label})` : ""}
                {s.environment === "sandbox" ? " — sandbox" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-400">MSISDN</span>
          <input
            value={msisdn}
            disabled={started}
            onChange={(e) => setMsisdn(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono"
          />
        </label>

        {sc && (
          <div className="text-xs text-slate-500 space-y-0.5">
            <div>Handler: <span className="font-mono break-all">{sc.handler_url}</span></div>
            <div>
              Auth: <span className="font-mono">{sc.auth_mode}</span>
              {sc.auth_mode === "bearer" && (sc.has_token ? " ✓ token set" : " ⚠ no token")}
              {" · "}Timeout: <span className="font-mono">{sc.timeout_secs}s</span>
            </div>
            {sc.status !== "active" && (
              <div className="text-amber-600 dark:text-amber-400">
                Shortcode status: {sc.status} — the live gateway would short-circuit;
                the simulator still calls your handler directly.
              </div>
            )}
          </div>
        )}

        {/* phone screen */}
        <div className="rounded-2xl border-4 border-slate-800 dark:border-slate-600 bg-slate-900 text-slate-100 p-4 min-h-[180px] flex flex-col">
          <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-2">
            {sc ? `${sc.operator_name} · ${sc.code}` : "USSD"}
            {sessionId && <span className="float-right normal-case font-mono">{sessionId}</span>}
          </div>
          <div className="flex-1 whitespace-pre-line text-sm leading-relaxed">
            {screen}
          </div>
          {active && (
            <form onSubmit={sendInput} className="mt-3 flex gap-2">
              <input
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Reply…"
                className="flex-1 rounded bg-slate-800 border border-slate-700 px-2 py-1 text-sm font-mono"
              />
              <button
                type="submit"
                disabled={pending}
                className="rounded bg-onfon-red px-3 py-1 text-sm font-medium disabled:opacity-50"
              >
                Send
              </button>
            </form>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={startSession}
            disabled={pending}
            className="rounded-md bg-onfon-red text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {started ? "Restart session" : "Start session"}
          </button>
          {started && (
            <button
              onClick={reset}
              disabled={pending}
              className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Clear
            </button>
          )}
          {pending && <span className="self-center text-xs text-slate-500">calling handler…</span>}
        </div>
      </div>

      {/* ---------------- per-leg transcript ---------------- */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Transcript</h2>
          <label className="text-xs flex items-center gap-1.5 text-slate-500">
            <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
            Raw request / reply
          </label>
        </div>

        {legs.length === 0 ? (
          <p className="text-sm text-slate-500">No legs yet.</p>
        ) : (
          <ol className="space-y-3">
            {legs.map((leg) => (
              <li key={leg.n} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    Leg {leg.n} · <span className="font-mono">{leg.event}</span>
                    {leg.event === "input" && leg.input !== "" && (
                      <> · input <span className="font-mono">&quot;{leg.input}&quot;</span></>
                    )}
                  </span>
                  <span className={`text-xs font-medium ${
                    leg.result.ok
                      ? (leg.result.verdict === "end" ? "text-slate-500" : "text-green-600 dark:text-green-400")
                      : "text-red-600 dark:text-red-400"}`}>
                    {VERDICT_LABEL[leg.result.verdict]}
                    {leg.result.httpStatus ? ` · HTTP ${leg.result.httpStatus}` : ""}
                    {` · ${leg.result.elapsedMs}ms`}
                  </span>
                </div>

                {leg.result.message != null && (
                  <div className="mt-1 whitespace-pre-line text-slate-700 dark:text-slate-300">
                    {leg.result.message}
                  </div>
                )}
                {leg.result.detail && !leg.result.ok && (
                  <div className="mt-1 text-red-600 dark:text-red-400">{leg.result.detail}</div>
                )}

                {showRaw && (
                  <div className="mt-2 grid gap-2">
                    <div>
                      <div className="text-[10px] uppercase text-slate-400">Request POST body</div>
                      <pre className="mt-0.5 overflow-x-auto rounded bg-slate-100 dark:bg-slate-800 p-2 text-[11px]">
{JSON.stringify(leg.result.requestBody, null, 2)}</pre>
                    </div>
                    {leg.result.rawReply != null && (
                      <div>
                        <div className="text-[10px] uppercase text-slate-400">Raw reply</div>
                        <pre className="mt-0.5 overflow-x-auto rounded bg-slate-100 dark:bg-slate-800 p-2 text-[11px]">
{leg.result.rawReply || "(empty)"}</pre>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
