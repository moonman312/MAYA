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

  // Top-aligned rather than centred, so the two titles sit on the same line.
  // Centring each card's content independently made the long note under one
  // button shove its title upward, and two headings at different heights reads
  // as a mistake before anyone gets as far as the words.
  const buttonBase =
    "group flex min-h-48 cursor-pointer flex-col items-center justify-start gap-3 rounded-2xl border-2 px-6 py-10 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const labelBase = "text-2xl font-semibold";

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center">
      <div className="grid w-full gap-5 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => choose("guided")}
          disabled={pending !== null}
          className={`${buttonBase} border-sky-500/50 bg-sky-500/10 text-sky-100 hover:border-sky-400 hover:bg-sky-500/20`}
        >
          {pending === "guided" ? (
            <span className={labelBase}>One moment…</span>
          ) : (
            <>
              <span className={labelBase}>Hold My Hand</span>
              <span className="text-sm font-normal text-sky-200/80">(Recommended)</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => choose("self_serve")}
          disabled={pending !== null}
          className={`${buttonBase} border-slate-700 bg-slate-900 text-slate-100 hover:border-slate-500 hover:bg-slate-800`}
        >
          {pending === "self_serve" ? (
            <span className={labelBase}>One moment…</span>
          ) : (
            <>
              <span className={labelBase}>Let Me Drive</span>
              {/*
                Held back until they show interest in this one. The warning only
                matters to someone considering it, and spelling out everything
                they would lose, permanently, next to the recommended option
                makes the easy choice look like the complicated one.

                Always in the layout, only faded — so hovering does not resize
                the card under the cursor. Revealed on keyboard focus as well,
                and shown outright on touch, where there is no hover to reveal it
                with and hidden text would simply never be read.
              */}
              <span
                className="max-w-xs text-sm font-normal leading-relaxed text-slate-400 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              >
                Straight to your dashboard — no analysis of your data, no setup guidance. For
                experts only.
              </span>
            </>
          )}
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
