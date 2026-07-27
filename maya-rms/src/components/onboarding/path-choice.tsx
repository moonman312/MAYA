"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * First onboarding screen: pick how much help you want.
 * "Hold my hand" -> guided PMS connect + data analysis.
 * "Let me drive" -> straight to the dashboard, no questions asked.
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
      router.push(path === "guided" ? "/onboarding/connect" : "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-center pt-10 text-center">
      <h1 className="text-3xl font-semibold text-slate-100">
        Welcome to Maya
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-400">
        Two ways to get started. Both are easy — one just does more of the work
        for you. You can always change your mind later.
      </p>

      <div className="mt-10 grid w-full gap-4 sm:grid-cols-2">
        {/* Hold my hand */}
        <button
          type="button"
          onClick={() => choose("guided")}
          disabled={pending !== null}
          className="group cursor-pointer rounded-xl border border-sky-500/40 bg-slate-900 p-6 text-left transition-colors hover:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <div className="text-2xl">🤝</div>
          <h2 className="mt-3 text-lg font-semibold text-slate-100">
            Hold my hand
          </h2>
          <span className="mt-1 inline-block rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
            Recommended
          </span>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Connect your property management system and we&apos;ll do the rest —
            pull your booking history, study it, and suggest a pricing strategy
            built for your property. A few optional questions, no homework.
          </p>
          <div className="mt-4 text-sm font-medium text-sky-400 group-hover:text-sky-300">
            {pending === "guided" ? "One moment…" : "Start here →"}
          </div>
        </button>

        {/* Let me drive */}
        <button
          type="button"
          onClick={() => choose("self_serve")}
          disabled={pending !== null}
          className="group cursor-pointer rounded-xl border border-slate-800 bg-slate-900 p-6 text-left transition-colors hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <div className="text-2xl">🚗</div>
          <h2 className="mt-3 text-lg font-semibold text-slate-100">
            Let me drive
          </h2>
          <span className="mt-1 inline-block rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
            For the hands-on
          </span>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Skip the setup and go straight to the dashboard. You can connect
            your PMS and build pricing rules yourself, at your own pace.
          </p>
          <div className="mt-4 text-sm font-medium text-slate-400 group-hover:text-slate-300">
            {pending === "self_serve" ? "One moment…" : "Take me to the dashboard →"}
          </div>
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
