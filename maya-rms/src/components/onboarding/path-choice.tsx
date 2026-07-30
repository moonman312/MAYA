"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The last onboarding screen, and deliberately the only thing on it.
 *
 * By the time anyone gets here they have paid and their PMS is connected, so the
 * import is already running either way and there is exactly one decision left:
 * be walked through the rest, or go and drive. Two buttons in the middle of the
 * screen. Anything else on this page is a reason to hesitate over a choice that
 * cannot be got wrong — both paths end up in the same product, and it can be
 * changed afterwards.
 */
export function PathChoice() {
  const router = useRouter();
  const [pending, setPending] = useState<"guided" | "self_serve" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(path: "guided" | "self_serve") {
    setPending(path);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Something went wrong. Please try again.");
      }
      // Guided goes to the strategy questions — the PMS connect that used to sit
      // in front of them has already happened. Self-serve goes to a dashboard
      // that has a property in it, with the import filling it in as they look.
      router.push(path === "guided" ? "/onboarding/questions" : "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      setPending(null);
    }
  }

  const buttonBase =
    "flex min-h-40 cursor-pointer items-center justify-center rounded-2xl border-2 px-8 text-center text-2xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center">
      <div className="grid w-full gap-5 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => choose("guided")}
          disabled={pending !== null}
          className={`${buttonBase} border-sky-500/50 bg-sky-500/10 text-sky-100 hover:border-sky-400 hover:bg-sky-500/20`}
        >
          {pending === "guided" ? "One moment…" : "Hold My Hand"}
        </button>

        <button
          type="button"
          onClick={() => choose("self_serve")}
          disabled={pending !== null}
          className={`${buttonBase} border-slate-700 bg-slate-900 text-slate-100 hover:border-slate-500 hover:bg-slate-800`}
        >
          {pending === "self_serve" ? "One moment…" : "Let Me Drive"}
        </button>
      </div>

      {error ? (
        <p className="mt-6 rounded border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
