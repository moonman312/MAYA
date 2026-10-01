"use client";

import { useState } from "react";

type Outcome = { ok: true } | { ok: false; error: string };

/**
 * "Send a test line" for the #maya-signups feed, beside the alert test on the
 * Command Center. The database posts it through the webhook real signups
 * use, and the answer says whether it was queued or what is missing.
 */
export function SignupsFeedTestButton() {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function send() {
    setPending(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/admin/signups-feed/test", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setOutcome(res.ok ? { ok: true } : { ok: false, error: body.error ?? "Couldn't send the test line." });
    } catch {
      setOutcome({ ok: false, error: "Could not reach the server." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xs uppercase tracking-wide text-slate-500">#maya-signups</h2>
          <p className="mt-1 max-w-xl text-sm text-slate-300">
            One line per real signup milestone, posted by the database. Send a test line to check it arrives.
          </p>
        </div>
        <button
          type="button"
          onClick={send}
          disabled={pending}
          className="rounded border border-slate-700 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send a test line"}
        </button>
      </div>
      {outcome?.ok ? <p className="mt-2 text-sm text-emerald-300">Queued. Check #maya-signups for it.</p> : null}
      {outcome && !outcome.ok ? <p className="mt-2 text-sm text-rose-300">{outcome.error}</p> : null}
    </section>
  );
}
