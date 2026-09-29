"use client";

import { useState } from "react";

/**
 * Makes this property the active one for the signed-in platform admin and
 * opens the dashboard on it. Viewing is theirs; changing anything there
 * still needs God Mode.
 */
export function OpenPropertyButton({ hotelId }: { hotelId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/hotels/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not open this property.");
        return;
      }
      window.location.assign("/");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void open()}
        disabled={pending}
        className="cursor-pointer rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-60"
      >
        Open this property
      </button>
      {error ? <p className="text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
