"use client";

import { useState, useTransition } from "react";
import { refreshAnalytics } from "@/app/admin/analytics/actions";

/** Throws away the kept numbers and works them out again from now. */
export function AnalyticsRefresh() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await refreshAnalytics().catch(() => ({ ok: false as const, error: "Could not reach the server." }));
            if (!result.ok) setError(result.error);
          })
        }
        className="cursor-pointer rounded border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Refreshing…" : "Refresh"}
      </button>
      {error ? <span className="text-xs text-rose-300">{error}</span> : null}
    </span>
  );
}
