/**
 * Handler Simulator — logged-in clients fire simulated USSD legs at
 * their own shortcode's handler URL and watch the CON/END replies
 * render like a phone screen. Read-only against the gateway (nothing
 * is logged to ussd_session_logs); it only calls the client's handler.
 */
import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { loadSimulatableShortcodes } from "@/lib/simulator";
import Simulator from "./_simulator";

export const metadata = { title: "Handler Simulator · UssdGatewayTz" };

export default async function SimulatorPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const shortcodes = await loadSimulatableShortcodes(session.shortcodeIds);

  return (
    <div className="max-w-5xl">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold">Handler Simulator</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Send a simulated USSD session to one of your shortcodes&rsquo; handler
          URLs and step through the menu — exactly the unified JSON the gateway
          POSTs, with the same <code>CON</code>/<code>END</code> reply rules.
          Nothing here touches live MNO traffic or the session logs.
        </p>
      </header>

      {shortcodes.length === 0 ? (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-6 text-sm text-slate-600 dark:text-slate-400">
          You don&rsquo;t have any shortcodes to simulate yet. Ask an
          administrator to register a shortcode with your handler URL, then it
          will appear here.
        </div>
      ) : (
        <Simulator shortcodes={shortcodes} />
      )}
    </div>
  );
}
