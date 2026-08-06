"use client";

import { useState } from "react";

/**
 * One PMS's access-code switch. Mirrors SimulationModeToggle: optimistic flip,
 * revert on failure, a plain-language sentence under it rather than trusting
 * the label alone to explain what ON versus OFF actually does.
 */
export function PmsSignupGateToggle({
  pmsType,
  displayName,
  requiresSignupCode,
}: {
  pmsType: string;
  displayName: string;
  requiresSignupCode: boolean;
}) {
  const [required, setRequired] = useState(requiresSignupCode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setError(null);
    const next = !required;
    setRequired(next);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/pms-gates/${pmsType}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiresSignupCode: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setRequired(!next);
        setError(body.error ?? "Could not save that.");
      }
    } catch {
      setRequired(!next);
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded border border-slate-800 bg-slate-900 p-4">
      <div>
        <div className="text-sm font-medium text-slate-100">{displayName}</div>
        <p className="mt-1 max-w-md text-xs text-slate-400">
          {required
            ? "Signing up with this PMS needs a valid access code, same as every property today."
            : "Anyone can sign up and connect this PMS with no code. A discount or trial code is still honoured if they have one."}
        </p>
        {error && <p className="mt-1 text-xs text-rose-300">{error}</p>}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={required}
        aria-label={`Require an access code for ${displayName}`}
        onClick={toggle}
        disabled={pending}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition ${
          required ? "bg-sky-500" : "bg-slate-700"
        } ${pending ? "opacity-60" : ""}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
            required ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
