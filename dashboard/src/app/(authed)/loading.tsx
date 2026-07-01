/**
 * Nav-progress skeleton — shows the SECOND a user clicks a sidebar
 * link, before the server component finishes rendering. Without a
 * `loading.tsx` at this level the App Router renders nothing at all
 * during the RSC round-trip and users see the "nothing happened"
 * symptom on slow queries (7d/30d /sessions, etc.).
 *
 * Kept intentionally spartan: a header row + a 10-row shimmer table.
 * Per-page loading.tsx files can override with a shape that mirrors
 * the specific page's layout (see sessions/loading.tsx for the
 * report-style variant).
 */
export default function AuthedLoading() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 w-48 rounded-md bg-slate-200 dark:bg-slate-800" />
      <div className="h-9 rounded-md bg-slate-100 dark:bg-slate-900/50" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-9 bg-slate-100 dark:bg-slate-900/40" />
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-10 bg-white dark:bg-slate-900" />
          ))}
        </div>
      </div>
    </div>
  );
}
