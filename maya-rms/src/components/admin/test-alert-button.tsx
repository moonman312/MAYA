"use client";

import { useState } from "react";

type Outcome = { ok: true; fn: string | null; minSeverity: string | null } | { ok: false; error: string };

/**
 * "Send a test alert" on the Command Center. The message is sent by a
 * scheduled sync function, with the settings real alerts use, and the answer
 * is what that function found. The page tells the button whether the app
 * can ask a function at all (never any secret); when it cannot, the button
 * is off and says why.
 */
export function TestAlertButton({ problem }: { problem: string | null }) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function send() {
    setPending(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/admin/alerts/test", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; fn?: string; minSeverity?: string };
      setOutcome(
        res.ok
          ? { ok: true, fn: body.fn ?? null, minSeverity: body.minSeverity ?? null }
          : { ok: false, error: body.error ?? "Couldn't send the test alert." },
      );
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
          <h2 className="text-xs uppercase tracking-wide text-slate-500">Alerts</h2>
          <p className="mt-1 max-w-xl text-sm text-slate-300">
            Has a scheduled sync function post one message to the alert channel, with the settings real alerts use, so you can
            see alerts arrive.
          </p>
        </div>
        <button
          type="button"
          onClick={send}
          disabled={problem !== null || pending}
          className="rounded border border-slate-700 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send a test alert"}
        </button>
      </div>
      {problem ? <p className="mt-2 text-sm text-amber-200">{problem}</p> : null}
      {outcome?.ok ? (
        <p className="mt-2 text-sm text-emerald-300">
          Sent{outcome.fn ? ` through ${outcome.fn}` : ""}. Check the alert channel for it.
          {outcome.minSeverity === "critical" ? " Real alerts go out for critical problems only (MAYA_ALERT_MIN_SEVERITY)." : ""}
        </p>
      ) : null}
      {outcome && !outcome.ok ? <p className="mt-2 text-sm text-rose-300">{outcome.error}</p> : null}
    </section>
  );
}
