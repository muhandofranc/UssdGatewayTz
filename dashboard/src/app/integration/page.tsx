/**
 * Integration guide — the contract between UssdGatewayTz and a
 * partner's handler URL. Aimed at prospective clients (pre-onboarding
 * reading) AND signed-in operators, so the route is **public**: rbac
 * marks /integration null in `requiredPermFor`, and the page sits at
 * the root of `app/` (NOT under (authed)/) so it never hits the
 * session-redirect in the authed layout.
 *
 * No DB hit, no per-user state — content is identical for everyone.
 * Static-rendered. The lightweight top bar below adapts to session
 * state so signed-in users have a "Back to dashboard" exit and
 * anonymous visitors have a "Sign in" CTA.
 */
import Link from "next/link";
import { Suspense } from "react";

import { getSession } from "@/lib/auth";

export const metadata = {
  title: "Integration · UssdGatewayTz",
};

export default async function IntegrationPage() {
  // Best-effort session read — null when the visitor is anonymous.
  // Page renders identically either way; only the top bar differs.
  const session = await getSession();

  return (
    <Suspense>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
        {/* Public top bar — replaces the (authed) sidebar we left behind
            when the page moved out of the group. Keep it intentionally
            spartan so it doesn't compete with the documentation body. */}
        <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
            <Link href="/" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              UssdGatewayTz
            </Link>
            {session ? (
              <Link href="/"
                    className="text-sm text-onfon-red hover:underline">
                ← Back to dashboard
              </Link>
            ) : (
              <Link href={`/login?next=/integration`}
                    className="text-sm rounded-md bg-onfon-red text-white px-3 py-1.5 hover:opacity-90 transition">
                Sign in
              </Link>
            )}
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-8">
      <article className="max-w-4xl space-y-8">
        <header>
          <h1 className="text-2xl font-semibold">Handler integration guide</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Your handler is an HTTP endpoint we POST live USSD legs to.
            One request per screen the subscriber sees; you reply with the
            next screen body or terminate the session.
          </p>
        </header>

        <Section title="1. Request — what we POST you">
          <p className="text-sm">
            One <code>POST</code> per USSD leg, JSON body, against the URL you
            gave during onboarding. <code>Authorization</code> is included only
            if you picked <code>bearer</code> for <code>auth_mode</code>; for
            <code>auth_mode=none</code> we lean on VPN / IP allowlisting.
          </p>
          <Code>{`POST https://your-handler.example/ussd
Content-Type: application/json
Authorization: Bearer <your-token>      # only if auth_mode=bearer

{
  "operator":     "vodacom",            // vodacom | airtel | tigo | halotel
  "msisdn":       "255712345678",       // E.164-ish, MNO-normalised
  "session_id":   "ABC123",             // STABLE across legs — key your state by this
  "service_code": "*123#",              // dialed code (Vodacom/Halotel) OR
                                        // partner slug (Airtel/Tigo, e.g. "glptigo")
  "ussd_string":  "1*2",                // accumulated trail, "*" between inputs
  "event":        "input",              // "start" | "input" | an end-of-session event (section 3)
  "raw_payload":  { ... }               // OPTIONAL — verbatim MNO-native payload (forensics)
}`}</Code>
          <FieldTable
            rows={[
              ["operator",     "string",  "Which MNO this leg came from. Routing key for any per-MNO branching."],
              ["msisdn",       "string",  "Subscriber number, MNO-normalised. Use as-is — don't strip leading digits."],
              ["session_id",   "string",  "Same for every leg in one USSD dialog. Your state cache key."],
              ["service_code", "string",  "What was onboarded — a dialed code (Vodacom/Halotel) or a partner slug (Airtel/Tigo)."],
              ["ussd_string",  "string",  "User's full input trail joined by '*'. Example: '1*2*BalanceCode'."],
              ["event",        "enum",    `"start" on the first leg of a new session; "input" on every leg after. One of "user_cancelled", "timeout", "charge_failed" or "session_expired" when the session has ended (section 3).`],
              ["raw_payload",  "object (optional)",  "Original MNO-native payload (XML-as-dict for SOAP, query/form for the rest). NOT mandatory — present for forensics only; the normalised fields above are the contract."],
            ]}
          />
        </Section>

        <Section title="2. Response — what you reply">
          <p className="text-sm">
            Either JSON or plain text. Both are accepted; pick whichever fits
            your stack. Reply within <strong>5 seconds</strong> (per-handler
            timeout configurable but 5s is the default). After timeout we
            return a generic error to the MNO; the session is lost.
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <h3 className="text-sm font-semibold mb-2">JSON</h3>
              <Code>{`HTTP/1.1 200 OK
Content-Type: application/json

{
  "action":  "CON",                     // "CON" = keep session open
                                        // "END" = terminate the session
  "message": "1. Balance\\n2. Buy airtime"
}`}</Code>
            </div>
            <div>
              <h3 className="text-sm font-semibold mb-2">Plain text</h3>
              <Code>{`HTTP/1.1 200 OK
Content-Type: text/plain

CON 1. Balance
2. Buy airtime`}</Code>
              <p className="text-xs text-slate-500 mt-2">
                First word is the verb (<code>CON</code> or <code>END</code>),
                the rest is the body shown to the subscriber. Newlines render
                on most handsets up to ~160 chars total.
              </p>
            </div>
          </div>
          <FieldTable
            rows={[
              ["action / verb", "enum",   `"CON" keeps the session open for the next leg. "END" terminates and shows the final screen.`],
              ["message / body", "string", "What the subscriber sees. Keep ≤ 160 characters; longer text is truncated by the MNO."],
            ]}
          />
        </Section>

        <Section title="3. End-of-session events">
          <p className="text-sm">
            When a session ends without your handler replying <code>END</code>,
            we POST you one more request so you can release whatever you were
            holding for that <code>session_id</code> (cart, OTP, half-done
            payment). It has the same body as any other leg; only{" "}
            <code>event</code> tells it apart. <strong>Check{" "}
            <code>event</code> before you treat the body as user input.</strong>
          </p>
          <FieldTable
            head={["event", "Sent by", "Meaning"]}
            rows={[
              ["user_cancelled",  "Vodacom, Halotel", "The subscriber cancelled or hung up. Vodacom also reports its own 60-second idle cut-off this way."],
              ["timeout",         "Vodacom, Halotel", "The network closed the session itself."],
              ["charge_failed",   "Vodacom",          "A premium-rate charge for the session failed."],
              ["session_expired", "Gateway (all networks)", "No leg arrived for the network's idle limit, so the gateway declared the session dead. The only end signal you will ever get on Airtel and Tigo, which never report cancels or timeouts."],
            ]}
          />
          <ul className="list-disc pl-5 text-sm space-y-2">
            <li>
              <strong>Notification only.</strong> The subscriber is already
              gone, so your reply is not shown to anyone. Reply{" "}
              <code>END</code> with an empty message and keep it fast.
            </li>
            <li>
              <strong>At most one per session</strong>, and never after you
              have already replied <code>END</code>. Handle it idempotently
              anyway: release state only if you still hold it.
            </li>
            <li>
              <code>ussd_string</code> carries the trail as it stood when the
              session ended, so you can see where the subscriber stopped.
            </li>
            <li>
              <code>session_expired</code> has no network request behind it.
              Its <code>raw_payload</code> is{" "}
              <code>{`{"_source": "gateway_session_expiry", "idle_secs": …, "last_seen_at": …}`}</code>.
            </li>
            <li>
              Idle limits are set per network so the gateway never cuts off a
              subscriber who is still typing: currently Vodacom 75s, Airtel
              120s, Halotel 120s and Tigo 130s. A session is declared expired
              a few seconds after its limit passes.
            </li>
            <li>
              Not sent when the shortcode is in <code>maintenance</code> or{" "}
              <code>deactivated</code>: your handler never saw that session.
            </li>
          </ul>
          <Code>{`{
  "operator":     "tigo",
  "msisdn":       "255712345678",
  "session_id":   "ABC123",
  "service_code": "glptigo",
  "ussd_string":  "1*2",
  "event":        "session_expired",
  "raw_payload":  {
    "_source":      "gateway_session_expiry",
    "idle_secs":    130,
    "last_seen_at": "2026-10-22 09:14:03.512+03"
  }
}`}</Code>
        </Section>

        <Section title="4. Legacy payload format">
          <p className="text-sm">
            Handlers migrated from the pre-gateway senders can be onboarded
            with <code>payload_format=legacy</code>. They get the old key
            names, with no <code>event</code> and no{" "}
            <code>raw_payload</code>. The reply contract (section 2) is
            identical.
          </p>
          <Code>{`{
  "sessionId":       "ABC123",
  "msisdn":          "255712345678",
  "networkProvider": "VODACOM",          // operator, upper-case
  "serviceCode":     "*149*76#",
  "UssdString":      "1*2"               // capital U is part of the contract
}`}</Code>
          <p className="text-sm">
            With no <code>event</code> key, end-of-session events arrive as a
            sentinel that <strong>replaces</strong> the trail in{" "}
            <code>UssdString</code>:
          </p>
          <FieldTable
            head={["UssdString", "Equivalent event", "Meaning"]}
            rows={[
              ["__USER_CANCELLED__",  "user_cancelled",  "Subscriber cancelled or hung up."],
              ["__TIMEOUT__",         "timeout",         "Network closed the session."],
              ["__CHARGE_FAILED__",   "charge_failed",   "Premium-rate charge failed."],
              ["__SESSION_EXPIRED__", "session_expired", "Gateway idle limit reached."],
            ]}
          />
          <p className="text-sm">
            A legacy handler <strong>must check for these values before
            walking its menu</strong>. Otherwise it treats the sentinel as
            input, and at a free-text step (amount, account number, name) it
            may save it as a real value.
          </p>
        </Section>

        <Section title="5. Working example — curl">
          <Code>{`# Replay an "input" leg against your handler:
curl -X POST https://your-handler.example/ussd \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer <your-token>' \\
  -d '{
    "operator":     "vodacom",
    "msisdn":       "255712345678",
    "session_id":   "smoke-001",
    "service_code": "*123#",
    "ussd_string":  "1",
    "event":        "input",
    "raw_payload":  {}
  }'

# Your reply (JSON):
{ "action": "END", "message": "Your balance is TZS 1,234.00. Thank you." }`}</Code>
        </Section>

        <Section title="6. Notes / common pitfalls">
          <ul className="list-disc pl-5 text-sm space-y-2">
            <li>
              <strong>State by <code>session_id</code></strong> — not by
              <code>msisdn</code>. The same subscriber can have two concurrent
              sessions on different MNOs.
            </li>
            <li>
              <strong>The first leg is <code>event="start"</code></strong> with
              <code>ussd_string=""</code>. Treat it as "open a fresh menu" and
              ignore <code>ussd_string</code> on that leg.
            </li>
            <li>
              <strong>Timeouts terminate the session.</strong> If your handler
              takes &gt; 5 s the gateway returns an error to the MNO and the
              dialog dies — there's no retry of the same leg.
            </li>
            <li>
              <strong>Don&apos;t wait for an end event to clean up.</strong>{" "}
              Sessions you close with <code>END</code> get none, so release
              state when you send <code>END</code> as well.
            </li>
          </ul>
        </Section>
      </article>
        </main>
      </div>
    </Suspense>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold border-b border-slate-200 dark:border-slate-800 pb-1">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="text-xs bg-slate-900 text-slate-100 rounded-md p-3 overflow-x-auto leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function FieldTable({
  rows, head = ["Field", "Type", "Meaning"],
}: {
  rows: Array<[string, string, string]>;
  head?: [string, string, string];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border border-slate-200 dark:border-slate-800 rounded-md">
        <thead className="bg-slate-50 dark:bg-slate-800 text-left">
          <tr>
            {head.map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([f, t, m], i) => (
            <tr key={f} className={i % 2 ? "bg-slate-50/50 dark:bg-slate-900/30" : ""}>
              <td className="px-3 py-2 font-mono">{f}</td>
              <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{t}</td>
              <td className="px-3 py-2">{m}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
