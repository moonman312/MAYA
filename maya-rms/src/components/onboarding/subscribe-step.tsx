"use client";

import { useEffect, useState } from "react";
import {
  MAX_ROOMS,
  annualDiscountPct,
  formatPerRoom,
  formatUsd,
  isBillableRoomCount,
  priceCents,
  tierFor,
  type BillingInterval,
} from "@/lib/billing/tiers";

/**
 * First screen of the flow: room count, billing period, code.
 *
 * The price updates as they type, because the whole property bills at its
 * bracket's rate and that is genuinely surprising the first time you see it —
 * better to watch the number move than to discover it on a card statement.
 */
export function SubscribeStep({ cancelled = false }: { cancelled?: boolean }) {
  const [roomsText, setRoomsText] = useState("");
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [code, setCode] = useState("");
  const [codeState, setCodeState] = useState<
    { status: "idle" } | { status: "checking" } | { status: "good"; grants: string } | { status: "bad"; message: string }
  >({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rooms = Number(roomsText);
  const roomsOk = isBillableRoomCount(rooms);
  const perRoom = roomsOk ? tierFor(rooms).centsPerRoom : 0;
  const total = roomsOk ? priceCents(rooms, interval) : 0;
  const discount = roomsOk ? annualDiscountPct(rooms) : 0;

  // Check the code a beat after typing stops, so every keystroke isn't a request.
  //
  // Re-runs on the interval too, not just the text: a fixed price is agreed per
  // period and a limited discount is worth different money on a yearly invoice,
  // so the same code can be good monthly and refused annually. Without that,
  // toggling the period left a stale "valid" verdict on screen that checkout
  // would then reject.
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
        const body = (await res.json()) as { valid?: boolean; grants?: string; message?: string };
        if (!current) return;
        setCodeState(
          body.valid
            ? { status: "good", grants: body.grants ?? "" }
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

  const canSubmit = roomsOk && codeState.status === "good" && !submitting;

  async function subscribe() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rooms, interval, code: code.trim() }),
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
      <h1 className="text-3xl font-semibold text-slate-100">Let&apos;s get you set up</h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">
        Pricing is per room, per month. Tell us how big the property is and
        we&apos;ll show you the number before you commit to anything.
      </p>

      {cancelled ? (
        <p className="mt-5 max-w-lg rounded border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm text-slate-300">
          No charge was made — you left checkout before finishing. Pick up where
          you left off whenever you&apos;re ready.
        </p>
      ) : null}

      <div className="mt-8 max-w-lg space-y-6">
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
              {formatUsd(total)}
              <span className="ml-2 text-sm font-normal text-slate-400">
                / {interval === "month" ? "month" : "year"}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-slate-400">
              {rooms} rooms at {formatPerRoom(perRoom)} per room
              {interval === "year" && discount > 0 ? `, less ${discount}%` : ""}.
            </p>
          </div>
        ) : null}

        <label className="block">
          <span className="text-sm font-medium text-slate-200">Your code</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="MHSFOUNDER"
            autoCapitalize="characters"
            className="mt-2 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-sm uppercase tracking-wide text-slate-100"
          />
          {codeState.status === "checking" ? (
            <p className="mt-1.5 text-xs text-slate-400">Checking…</p>
          ) : codeState.status === "good" ? (
            <p className="mt-1.5 text-xs text-emerald-300">{codeState.grants}</p>
          ) : codeState.status === "bad" ? (
            <p className="mt-1.5 text-xs text-rose-300">{codeState.message}</p>
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
            type="button"
            onClick={subscribe}
            disabled={!canSubmit}
            className="cursor-pointer rounded bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Taking you to checkout…" : "Continue to payment"}
          </button>
          <p className="mt-2 text-[11px] text-slate-600">
            Card details are handled by Stripe — they never touch MAYA. Next
            you&apos;ll connect your PMS.
          </p>
        </div>
      </div>
    </div>
  );
}
