"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
 * for the case where waiting genuinely didn't work.
 */

/** Frequent at first, easing off — the webhook almost always lands in seconds. */
const POLL_MS = 1200;
/** After this, stop pretending it is about to happen and say something useful. */
const PATIENCE_MS = 25_000;

export function ConfirmingPayment() {
  const router = useRouter();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // Inside the effect, not a ref seeded during render: reading the clock while
    // rendering is impure, and the effect owns this whole lifetime anyway.
    const startedAt = Date.now();
    let alive = true;
    let timer: number;

    async function check() {
      if (!alive) return;
      try {
        const res = await fetch("/api/onboarding/step", { cache: "no-store" });
        if (res.ok) {
          const { step } = (await res.json()) as { step?: string };
          // Anything past "subscribe" means the payment is recorded. Pushing
          // rather than replacing would leave this screen in their history,
          // where Back lands them on a spinner for a thing already finished.
          if (step && step !== "subscribe") {
            router.replace(step === "connect" ? "/onboarding/connect" : "/onboarding");
            return;
          }
        }
      } catch {
        // A dropped request is not news — the next poll covers it.
      }
      if (!alive) return;
      if (Date.now() - startedAt > PATIENCE_MS) setSlow(true);
      timer = window.setTimeout(check, POLL_MS);
    }

    check();
    return () => {
      alive = false;
      window.clearTimeout(timer);
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
        {slow
          ? "Your payment went through, but our side is taking longer than usual to catch up."
          : "Setting up your account — this takes a few seconds."}
      </p>

      {!slow && (
        <div
          className="mx-auto mt-6 h-1 w-32 overflow-hidden rounded-full bg-slate-800"
          role="status"
          aria-label="Setting up your account"
        >
          <div className="h-full w-1/3 animate-[maya-slide_1.4s_ease-in-out_infinite] rounded-full bg-emerald-400" />
        </div>
      )}

      {slow && (
        <div className="mt-6 space-y-3">
          <p className="text-sm text-slate-400">
            Nothing is lost and you have not been charged twice. You can leave this page — we&apos;ll
            email you when it&apos;s ready, and your card details are already saved.
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
