"use client";

/**
 * The "Older" button under the change log and under a rule's fire log
 * (src/lib/changelog-paging.ts): it reads the next, older page and adds it
 * below. Once the oldest page is in, a muted line says that is all there is.
 * A failed read says so beside the button, which tries again.
 */
export function OlderButton({
  hasOlder,
  busy,
  error,
  endLine,
  onOlder,
}: {
  hasOlder: boolean;
  busy: boolean;
  error: string | null;
  /** Said once there is nothing older; null says nothing. */
  endLine: string | null;
  onOlder: () => void;
}) {
  if (!hasOlder) return endLine ? <p className="pt-1 text-xs text-slate-500">{endLine}</p> : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
      <button
        type="button"
        disabled={busy}
        onClick={onOlder}
        className="cursor-pointer rounded border border-slate-700 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-default disabled:opacity-60"
      >
        {busy ? "Loading…" : "Older"}
      </button>
      {error ? <span className="text-xs text-rose-300">{error}</span> : null}
    </div>
  );
}
