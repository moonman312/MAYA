"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  INITIAL_POLL_MS,
  nextPollDelay,
  phaseAfter,
  type ConfirmPhase,
} from "./confirm-poll";

/**
 * The moment right after the card is taken.
 *
 * Stripe's webhook is asynchronous, so for a second or two after paying there is
 * genuinely no record that they paid. Sending them onward during that gap put
 * someone who had just handed over a card back on the payment form with no
 * explanation — and paying twice was the obvious thing to do next.
 *
 * So this waits instead, and it costs nobody a click: it polls until the flow
 * says they can move on and then moves them on itself. The only interaction is
 * for the case where waiting genuinely didn't work. Pacing lives in
 * confirm-poll.ts; a hidden tab schedules nothing and asks once on return.
 */

export function ConfirmingPayment() {
  const router = useRouter();
  const [phase, setPhase] = useState<ConfirmPhase>("waiting");

  useEffect(() => {
    // Inside the effect, not a ref seeded during render: reading the clock while
    // rendering is impure, and the effect owns this whole lifetime anyway.
    const startedAt = Date.now();
    let alive = true;
    let done = false;
    let timer: number | undefined;
    let delay = INITIAL_POLL_MS;

    async function check() {
      if (!alive || done) return;
      try {
        const res = await fetch("/api/onboarding/step", { cache: "no-store" });
        if (res.ok) {
          const { step } = (await res.json()) as { step?: string };
          // Anything past "subscribe" means the payment is recorded. Pushing
          // rather than replacing would leave this screen in their history,
          // where Back lands them on a spinner for a thing already finished.
          if (step && step !== "subscribe") {
            done = true;
            router.replace(step === "connect" ? "/onboarding/connect" : "/onboarding");
            return;
          }
        }
      } catch {
        // A dropped request is not news — the next poll covers it.
      }
      if (!alive || done) return;
      const next = phaseAfter(Date.now() - startedAt);
      setPhase(next);
      if (next === "stalled") {
        done = true;
        return;
      }
      schedule();
    }

    function schedule() {
      // Nobody is looking at a hidden tab; onVisible asks the moment they are.
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(check, delay);
      delay = nextPollDelay(delay);
    }

    function onVisibilityChange() {
      if (!alive || done) return;
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void check();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    void check();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-6 text-emerald-400"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>

      <h1 className="mt-5 text-xl font-semibold text-slate-100">Payment received</h1>
      <p className="mt-2 text-sm text-slate-400" aria-live="polite">
        {phase === "waiting" && "Setting up your account — this takes a few seconds."}
        {phase === "slow" &&
          "Your payment went through, but our side is taking longer than usual to catch up."}
        {phase === "stalled" &&
          "Your payment went through, but confirming it here has stalled."}
      </p>

      {phase === "waiting" && (
        <div
          className="mx-auto mt-6 h-1 w-32 overflow-hidden rounded-full bg-slate-800"
          role="status"
          aria-label="Setting up your account"
        >
          <div className="h-full w-1/3 animate-[maya-slide_1.4s_ease-in-out_infinite] rounded-full bg-emerald-400" />
        </div>
      )}

      {phase !== "waiting" && (
        <div className="mt-6 space-y-3">
          <p className="text-sm text-slate-400">
            {phase === "stalled"
              ? "We've stopped checking automatically. Nothing is lost and you have not been charged twice — leave this page and we'll email you when it's ready, or ask again below."
              : "Nothing is lost and you have not been charged twice. You can leave this page — we'll email you when it's ready, and your card details are already saved."}
          </p>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="rounded border border-slate-600 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-400"
          >
            Check again
          </button>
        </div>
      )}

      <style>{`
        @keyframes maya-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  );
}
