/**
 * What a Command Center page shows the moment it is clicked, while the server
 * works it out. Having it also lets Next fetch each page's frame ahead of the
 * click (a page with no loading state is never fetched ahead), so the click
 * answers at once instead of leaving the last page on screen.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="h-8 w-56 animate-pulse rounded bg-slate-800/70" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-lg border border-slate-800 bg-slate-900/60" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg border border-slate-800 bg-slate-900/60" />
    </div>
  );
}
