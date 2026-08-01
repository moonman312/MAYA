"use client";

import type { SignupCodeKind } from "@/lib/billing/codes";
import { formatUsd, isBillableRoomCount, MAX_ROOMS, priceCents, type BillingInterval } from "@/lib/billing/tiers";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Draft = {
  code: string;
  kind: SignupCodeKind;
  trialDays: string;
  percentOff: string;
  amountOffDollars: string;
  /** Blank means forever, exactly as the column reads it. */
  durationMonths: string;
  interval: BillingInterval;
  rooms: string;
  maxRedemptions: string;
  expiresOn: string;
  notes: string;
};

const EMPTY: Draft = {
  code: "",
  kind: "trial",
  trialDays: "14",
  percentOff: "20",
  amountOffDollars: "50",
  durationMonths: "3",
  interval: "month",
  rooms: "40",
  maxRedemptions: "",
  expiresOn: "",
  notes: "",
};

const KINDS: { value: SignupCodeKind; label: string }[] = [
  { value: "trial", label: "Free trial" },
  { value: "percent_off", label: "Percent off" },
  { value: "amount_off", label: "Dollars off" },
  { value: "fixed_price", label: "Fixed price" },
];

/**
 * A date picker means "usable through that day", so the code dies at the end of
 * it rather than at its first minute.
 */
function expiryIso(day: string): string | null {
  if (!day) return null;
  const end = new Date(`${day}T23:59:59`);
  return Number.isNaN(end.getTime()) ? null : end.toISOString();
}

export function SignupCodeForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const rooms = Number(draft.rooms);
  const roomsOk = isBillableRoomCount(rooms);

  function submit() {
    setError(null);
    setCreated(null);
    const body: Record<string, unknown> = {
      code: draft.code,
      kind: draft.kind,
      max_redemptions: draft.maxRedemptions || null,
      expires_at: expiryIso(draft.expiresOn),
      notes: draft.notes,
    };
    if (draft.kind === "trial") {
      body.trial_days = draft.trialDays;
    } else if (draft.kind === "percent_off") {
      body.percent_off = Number(draft.percentOff);
      body.duration_months = draft.durationMonths || null;
    } else if (draft.kind === "amount_off") {
      // Typed in dollars, stored in cents — rounded here so "49.999" can't
      // reach the API as a fractional cent.
      body.amount_off_cents = Math.round(Number(draft.amountOffDollars) * 100);
      body.duration_months = draft.durationMonths || null;
    } else {
      body.fixed_price_interval = draft.interval;
      body.tier_rooms_cap = draft.rooms;
    }

    startTransition(async () => {
      const res = await fetch("/api/admin/signup-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await res.json().catch(() => ({}))) as {
        code?: string;
        grants?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(result.error ?? "Could not create that code");
        return;
      }
      // The deal usually repeats across a batch of codes; the code and the note
      // never do.
      setDraft((d) => ({ ...d, code: "", notes: "" }));
      setCreated(`${result.code} — ${result.grants ?? ""}`);
      router.refresh();
    });
  }

  const canSubmit =
    draft.code.trim().length >= 3 &&
    (draft.kind === "trial"
      ? draft.trialDays.trim() !== ""
      : draft.kind === "percent_off"
        ? draft.percentOff.trim() !== ""
        : draft.kind === "amount_off"
          ? Number(draft.amountOffDollars) > 0
          : roomsOk);

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400"
        >
          + New code
        </button>
        {created && <span className="text-xs text-emerald-300">{created}</span>}
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded border border-slate-800 bg-slate-900 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-100">New code</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Close
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code">
          <input
            type="text"
            value={draft.code}
            onChange={(e) => set("code", e.target.value.toUpperCase())}
            placeholder="DRIFTWOOD"
            className="w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-sm uppercase tracking-wide text-slate-100"
          />
        </Field>
        <Field label="What it grants">
          <select
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value as SignupCodeKind)}
            className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {draft.kind === "trial" && (
        <Field label="Free days">
          <input
            type="number"
            min="1"
            value={draft.trialDays}
            onChange={(e) => set("trialDays", e.target.value)}
            className="w-32 rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
          />
        </Field>
      )}

      {draft.kind === "percent_off" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Percent off">
            <input
              type="number"
              min="1"
              max="100"
              value={draft.percentOff}
              onChange={(e) => set("percentOff", e.target.value)}
              className="w-32 rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
            />
          </Field>
          <Field label="For how many months (blank = forever)">
            <input
              type="number"
              min="1"
              value={draft.durationMonths}
              onChange={(e) => set("durationMonths", e.target.value)}
              className="w-32 rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
            />
          </Field>
        </div>
      )}

      {draft.kind === "amount_off" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Dollars off each month">
            <input
              type="number"
              min="1"
              step="0.01"
              value={draft.amountOffDollars}
              onChange={(e) => set("amountOffDollars", e.target.value)}
              className="w-32 rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
            />
          </Field>
          <Field label="For how many months (blank = forever)">
            <input
              type="number"
              min="1"
              value={draft.durationMonths}
              onChange={(e) => set("durationMonths", e.target.value)}
              className="w-32 rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
            />
          </Field>
        </div>
      )}

      {draft.kind === "fixed_price" && (
        <div className="space-y-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Billed">
              <select
                value={draft.interval}
                onChange={(e) => set("interval", e.target.value as BillingInterval)}
                className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
              >
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </select>
            </Field>
            <Field label="Bill them as this many rooms">
              <input
                type="number"
                min="1"
                max={MAX_ROOMS}
                value={draft.rooms}
                onChange={(e) => set("rooms", e.target.value)}
                className="w-32 rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
              />
            </Field>
          </div>
          <p className="text-xs text-slate-400">
            {roomsOk ? (
              <>
                Locks them at{" "}
                <span className="text-slate-200">
                  {formatUsd(priceCents(rooms, draft.interval))} per {draft.interval}
                </span>{" "}
                however many rooms they actually run. A fixed price has to land on a bracket —
                that bracket is what Stripe bills.
              </>
            ) : (
              <>A whole number of rooms from 1 to {MAX_ROOMS}.</>
            )}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Max redemptions (blank = unlimited)">
          <input
            type="number"
            min="1"
            value={draft.maxRedemptions}
            onChange={(e) => set("maxRedemptions", e.target.value)}
            className="w-32 rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
          />
        </Field>
        <Field label="Expires after (blank = never)">
          <input
            type="date"
            value={draft.expiresOn}
            onChange={(e) => set("expiresOn", e.target.value)}
            className="w-44 rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
          />
        </Field>
      </div>

      <Field label="Notes — who got it, and why">
        <textarea
          value={draft.notes}
          onChange={(e) => set("notes", e.target.value)}
          rows={2}
          placeholder="Gave this to the Driftwood GM in Austin"
          className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100"
        />
      </Field>

      {error && (
        <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
      {created && <p className="text-sm text-emerald-300">{created}</p>}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || pending}
          className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create code"}
        </button>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      <span className="uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}
