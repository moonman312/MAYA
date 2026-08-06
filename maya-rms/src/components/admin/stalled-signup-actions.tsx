"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Give up on a signup, or take it back.
 *
 * The note is the point of the flag — "flagged 3 weeks ago" tells the next person
 * nothing, "emailed twice, no reply, address bounces" tells them not to bother.
 * So the button opens the note field rather than acting straight away.
 */
export function StalledSignupActions({
  hotelId,
  abandonedAt,
  email,
}: {
  hotelId: string;
  abandonedAt: string | null;
  email: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  function send(abandoned: boolean, withNote?: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/stalled-signups/${hotelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ abandoned, note: withNote ?? null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(body.error ?? "Failed");
        return;
      }
      setAsking(false);
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {email && (
          <a
            href={`mailto:${email}?subject=${encodeURIComponent("Your MAYA setup")}`}
            className="rounded border border-sky-500/40 px-2 py-1 text-xs text-sky-300 hover:border-sky-400"
          >
            Email them
          </a>
        )}
        {abandonedAt ? (
          <button
            type="button"
            onClick={() => send(false)}
            disabled={pending}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-60"
          >
            Un-flag
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setAsking((v) => !v)}
            disabled={pending}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-slate-500 disabled:opacity-60"
          >
            Given up on it
          </button>
        )}
      </div>

      {asking && (
        <div className="flex items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did you try?"
            maxLength={280}
            className="w-56 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600"
          />
          <button
            type="button"
            onClick={() => send(true, note)}
            disabled={pending}
            className="rounded border border-amber-500/40 px-2 py-1 text-xs text-amber-300 hover:border-amber-400 disabled:opacity-60"
          >
            Flag
          </button>
        </div>
      )}

      {msg && <span className="text-xs text-rose-300">{msg}</span>}
    </div>
  );
}
