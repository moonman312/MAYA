"use client";

import { describeRoomChange, formatUsd, MAX_ROOMS, type BillingInterval } from "@/lib/billing/tiers";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * The card, receipts and cancellation live in Stripe's hosted portal, so this is
 * a door rather than a form. The button carries its own pending and error state
 * because the redirect can take a second and a dead-looking button gets clicked
 * twice.
 */
export function ManageBillingButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setError(body.error ?? "Could not open the billing portal.");
        setPending(false);
        return;
      }
      // Deliberately not resetting pending: the page is on its way out, and a
      // button that springs back to life invites a second session.
      window.location.href = body.url;
    } catch {
      setError("Could not reach the billing portal.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={open}
        disabled={pending}
        className="rounded bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-400 disabled:opacity-60"
      >
        {pending ? "Opening…" : "Update card, receipts & cancellation"}
      </button>
      <p className="text-xs text-slate-500">
        Opens Stripe, where your card, invoices and cancellation all live.
      </p>
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Changing the billed room count.
 *
 * Shows what the new bill will be BEFORE the change is committed — quoting
 * afterwards is how someone discovers a price they did not agree to. The quote
 * comes from the same bracket function the server prices with, so the two cannot
 * disagree.
 */
export function RoomCountForm({
  currentRooms,
  interval,
}: {
  currentRooms: number;
  interval: BillingInterval;
}) {
  const router = useRouter();
  const [rooms, setRooms] = useState(String(currentRooms));
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const parsed = Number(rooms);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_ROOMS;
  const changed = valid && parsed !== currentRooms;
  const quote = changed ? describeRoomChange(currentRooms, parsed, interval) : null;

  function save() {
    setError(null);
    setDone(false);
    startSaving(async () => {
      const res = await fetch("/api/billing/rooms", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rooms: parsed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not change the room count.");
        return;
      }
      setDone(true);
      // Stripe confirms through the webhook, which can land a moment later than
      // this response. Refreshing shows whatever has actually been recorded
      // rather than what we hope was.
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="billed-rooms" className="block text-xs text-slate-400">
            Rooms billed
          </label>
          <input
            id="billed-rooms"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_ROOMS}
            value={rooms}
            onChange={(e) => {
              setRooms(e.target.value);
              setDone(false);
            }}
            className="mt-1 w-32 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!changed || saving}
          className="rounded border border-slate-600 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-400 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Change"}
        </button>
      </div>

      {!valid && rooms !== "" && (
        <p role="alert" className="text-xs text-amber-300">
          Enter a whole number between 1 and {MAX_ROOMS}.
        </p>
      )}
      {quote && (
        <p className="text-xs text-slate-300">
          {quote.summary}
          {quote.deltaCents < 0 && (
            <span className="text-emerald-300">
              {" "}
              That is {formatUsd(Math.abs(quote.deltaCents))} less.
            </span>
          )}
        </p>
      )}
      {done && <p className="text-xs text-emerald-300">Room count updated.</p>}
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
