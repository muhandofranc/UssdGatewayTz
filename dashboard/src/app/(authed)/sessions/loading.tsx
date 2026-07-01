/**
 * /sessions loading fallback — shown during the RSC render when the
 * user changes filters (7d / 30d ranges are the slowest — see
 * db/018 for the perf fix).
 *
 * Shape mirrors the actual page: header, filter bar, table with
 * roughly the row count the user is about to see. Bigger visual
 * commitment than the shared authed/loading.tsx because the page
 * itself is heavier and users are more likely to sit through a
 * multi-second render.
 */
export default function SessionsLoading() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-8 w-40 rounded-md bg-slate-200 dark:bg-slate-800" />
        <div className="h-8 w-32 rounded-md bg-slate-100 dark:bg-slate-900/50" />
      </div>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-8 w-28 rounded-md bg-slate-100 dark:bg-slate-900/50" />
        ))}
      </div>
      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 rounded-md bg-slate-100 dark:bg-slate-900/40" />
        ))}
      </div>
      {/* Table shell */}
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-9 bg-slate-100 dark:bg-slate-900/40" />
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {Array.from({ length: 25 }).map((_, i) => (
            <div key={i} className="h-12 bg-white dark:bg-slate-900" />
          ))}
        </div>
      </div>
      <div className="text-xs text-slate-500 text-center pt-2">
        Loading sessions&hellip;
      </div>
    </div>
  );
}
