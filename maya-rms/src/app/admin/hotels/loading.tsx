/**
 * Shown between the hotel list and a hotel's own page (and back), which the
 * Command Center's own loading state doesn't cover: both live under /admin/hotels.
 */
export default function HotelsLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="h-8 w-64 animate-pulse rounded bg-slate-800/70" />
      <div className="h-40 animate-pulse rounded border border-slate-800 bg-slate-900/60" />
      <div className="h-64 animate-pulse rounded border border-slate-800 bg-slate-900/60" />
    </div>
  );
}
