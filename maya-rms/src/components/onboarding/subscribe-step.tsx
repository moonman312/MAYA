"use client";

import { useEffect, useState } from "react";
import { checkoutQuote, type CodeDisplayEffect } from "@/lib/billing/quote";
import {
  MAX_ROOMS,
  annualDiscountPct,
  formatPerRoom,
  formatUsd,
  isBillableRoomCount,
  type BillingInterval,
} from "@/lib/billing/tiers";

/**
 * First screen of the flow: room count, billing period, PMS, code.
 *
 * The price updates as they type, because the whole property bills at its
 * bracket's rate and that is genuinely surprising the first time you see it —
 * better to watch the number move than to discover it on a card statement.
 *
 * The PMS question is asked here, before payment, because it decides whether a
 * code is needed at all (each integration's gate lives at /admin/pms-access) —
 * finding out at the connect step would mean a card already charged and no
 * trial period softening the mistake.
 */
export type SubscribePmsOption = {
  type: string;
  displayName: string;
  requiresSignupCode: boolean;
};

/** Rendered at pick-a-plan time; Stripe stamps the authoritative date minutes
 *  later at session creation, so drift is bounded by how long they dawdle. */
function trialEndsOn(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SubscribeStep({
  cancelled = false,
  pmsOptions = [],
  title = "Let's get you set up",
  intro = "Pricing is per room, per month. Tell us how big the property is and we'll show you the number before you commit to anything.",
  footnote = "Card details are handled by Stripe — they never touch MAYA. Next you'll connect your PMS.",
  initialRooms,
  initialInterval,
  lockPms = false,
}: {
  cancelled?: boolean;
  pmsOptions?: SubscribePmsOption[];
  title?: string;
  intro?: string;
  footnote?: string;
  initialRooms?: number;
  initialInterval?: BillingInterval;
  /** The property's PMS is already known (a restart) — declare it, hide the picker. */
  lockPms?: boolean;
}) {
  const [roomsText, setRoomsText] = useState(initialRooms ? String(initialRooms) : "");
  const [interval, setInterval] = useState<BillingInterval>(initialInterval ?? "month");
  const [pmsType, setPmsType] = useState<string | null>(
    lockPms ? (pmsOptions[0]?.type ?? null) : null,
  );
  const [code, setCode] = useState("");
  const [codeState, setCodeState] = useState<
    | { status: "idle" }
    | { status: "checking" }
    | { status: "good"; grants: string; effect?: CodeDisplayEffect }
    | { status: "bad"; message: string }
  >({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Landing back here via the browser's back button restores this component
  // from the bfcache mid-"Taking you to checkout…", with the pay button
  // disabled and nothing in flight to ever re-enable it.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setSubmitting(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const rooms = Number(roomsText);
  const roomsOk = isBillableRoomCount(rooms);
  // Priced with the code's effect folded in, so this panel shows what Stripe
  // will actually present on the next screen.
  const quote = checkoutQuote(
    roomsOk ? rooms : 0,
    interval,
    codeState.status === "good" ? codeState.effect : undefined,
  );
  const discount = roomsOk ? annualDiscountPct(rooms) : 0;

  // Check the code a beat after typing stops, so every keystroke isn't a request.
  //
  // Re-runs on the interval too, not just the text: a limited discount is worth
  // different money on a yearly invoice than a monthly one, so the panel's
  // numbers have to be re-derived when the period flips.
  useEffect(() => {
    const typed = code.trim();
    if (!typed) {
      setCodeState({ status: "idle" });
      return;
    }
    setCodeState({ status: "checking" });

    // A request already in flight when this re-runs still resolves, and its
    // answer is about the PREVIOUS code or period. Landing late, it would
    // overwrite the newer verdict — approving a code that was since edited, or
    // disabling the pay button over a rejection that no longer applies.
    let current = true;

    const t = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/billing/validate-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: typed, interval }),
        });
        const body = (await res.json()) as {
          valid?: boolean;
          grants?: string;
          message?: string;
          effect?: CodeDisplayEffect;
        };
        if (!current) return;
        setCodeState(
          body.valid
            ? { status: "good", grants: body.grants ?? "", effect: body.effect }
            : { status: "bad", message: body.message ?? "That code didn't work." },
        );
      } catch {
        if (current) setCodeState({ status: "bad", message: "Couldn't check that code — try again." });
      }
    }, 450);

    return () => {
      current = false;
      window.clearTimeout(t);
    };
  }, [code, interval]);

  const selectedPms = pmsOptions.find((p) => p.type === pmsType) ?? null;
  // No selection reads as gated — the safe direction, and the button is
  // disabled until they pick anyway.
  const codeOptional = selectedPms ? !selectedPms.requiresSignupCode : false;
  // An OPTIONAL code is not an unchecked one: typed text still has to
  // validate. Only genuinely-empty gets to skip.
  const codeOk =
    codeState.status === "good" || (codeOptional && codeState.status === "idle");
  const canSubmit =
    roomsOk && (pmsOptions.length === 0 || pmsType !== null) && codeOk && !submitting;

  async function subscribe() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rooms,
          interval,
          code: code.trim(),
          // "other" stays undeclared: the server treats no PMS as code-required,
          // which is exactly what an unknown system should be.
          ...(pmsType && pmsType !== "other" ? { pmsType } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) throw new Error(body?.error ?? "Couldn't start checkout.");
      // Stripe's hosted page — card details never touch MAYA.
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start checkout.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col pt-10">
      <h1 className="text-3xl font-semibold text-slate-100">{title}</h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">{intro}</p>

      {cancelled ? (
        <p className="mt-5 max-w-lg rounded border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm text-slate-300">
          No charge was made — you left checkout before finishing. Pick up where
          you left off whenever you&apos;re ready.
        </p>
      ) : null}

      {/* A real form so Enter in any field submits — this is the screen where
          someone is most likely to type a number and hit return. */}
      <form
        className="mt-8 max-w-lg space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void subscribe();
        }}
      >
        <label className="block">
          <span className="text-sm font-medium text-slate-200">How many rooms?</span>
          <input
            type="number"
            min="1"
            max={MAX_ROOMS}
            value={roomsText}
            onChange={(e) => setRoomsText(e.target.value)}
            placeholder="e.g. 24"
            className="mt-2 w-32 rounded border border-slate-700 bg-slate-950 p-2 text-lg text-slate-100"
          />
          {roomsText && !roomsOk ? (
            <p className="mt-1.5 text-xs text-rose-300">
              A whole number between 1 and {MAX_ROOMS}.
            </p>
          ) : null}
        </label>

        <div>
          <span className="text-sm font-medium text-slate-200">Billing</span>
          <div className="mt-2 flex gap-3">
            {(["month", "year"] as BillingInterval[]).map((opt) => {
              const active = interval === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setInterval(opt)}
                  className={`cursor-pointer rounded-lg border px-4 py-2 text-sm transition-colors ${
                    active
                      ? "border-sky-400 bg-sky-500/10 text-sky-200"
                      : "border-slate-700 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {opt === "month" ? "Monthly" : "Yearly"}
                  {opt === "year" && roomsOk ? (
                    <span className="ml-2 text-xs text-slate-400">
                      {/* Never imply a saving the smallest properties don't get. */}
                      {discount > 0 ? `save ${discount}%` : "pay once a year"}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {roomsOk ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="text-3xl font-semibold text-slate-100">
              {formatUsd(quote.recurringCents)}
              <span className="ml-2 text-sm font-normal text-slate-400">
                / {interval === "month" ? "month" : "year"}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-slate-400">
              {rooms} room{rooms === 1 ? "" : "s"} at {formatPerRoom(quote.perRoomCents)} per room
              {interval === "year" ? " a month, billed as one year" : ""}
              {interval === "year" && discount > 0 ? `, less ${discount}%` : ""}.
            </p>
            {quote.firstCents !== quote.recurringCents ? (
              <p className="mt-1 text-xs text-emerald-300">
                {interval === "month" && quote.discountMonths
                  ? `First ${
                      quote.discountMonths === 1 ? "month" : `${quote.discountMonths} months`
                    }: ${formatUsd(quote.firstCents)} a month.`
                  : `First year: ${formatUsd(quote.firstCents)}.`}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-slate-500">
              {quote.trialDays
                ? `Nothing today — your first charge is ${formatUsd(quote.firstCents)} on ${trialEndsOn(quote.trialDays)}. Cancel anytime.`
                : "Billed when you finish checkout. Cancel anytime."}
            </p>
          </div>
        ) : null}

        {pmsOptions.length > 0 && !lockPms ? (
          <div>
            <span className="text-sm font-medium text-slate-200">
              Which property management system do you use?
            </span>
            <div className="mt-2 flex flex-wrap gap-3">
              {pmsOptions.map((pms) => {
                const active = pmsType === pms.type;
                return (
                  <button
                    key={pms.type}
                    type="button"
                    onClick={() => setPmsType(pms.type)}
                    className={`cursor-pointer rounded-lg border px-4 py-2 text-sm transition-colors ${
                      active
                        ? "border-sky-400 bg-sky-500/10 text-sky-200"
                        : "border-slate-700 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    {pms.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <label className="block">
          <span className="text-sm font-medium text-slate-200">
            {codeOptional ? "Your code (optional)" : "Your code"}
          </span>
          {/* No example code in the placeholder — the first one shipped was a
              live code, printed inside the very gate it opened. */}
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="characters"
            className="mt-2 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-sm uppercase tracking-wide text-slate-100"
          />
          {codeState.status === "checking" ? (
            <p className="mt-1.5 text-xs text-slate-400">Checking…</p>
          ) : codeState.status === "good" ? (
            <p className="mt-1.5 text-xs text-emerald-300">{codeState.grants}</p>
          ) : codeState.status === "bad" ? (
            <p className="mt-1.5 text-xs text-rose-300">{codeState.message}</p>
          ) : codeOptional ? (
            <p className="mt-1.5 text-xs text-slate-400">
              Got a discount or trial code? Enter it here — otherwise leave this
              blank.
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-slate-400">
              MAYA is invite-only for now — you&apos;ll have been given a code.
            </p>
          )}
        </label>

        {error ? (
          <p className="rounded border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
            {error}
          </p>
        ) : null}

        <div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="cursor-pointer rounded bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Taking you to checkout…" : "Continue to payment"}
          </button>
          <p className="mt-2 text-[11px] text-slate-600">{footnote}</p>
        </div>
      </form>
    </div>
  );
}
