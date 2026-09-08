"use client";

import { useState } from "react";

/** Mirrors SimulationModeToggle: optimistic flip, revert on failure. */
export function HotelTestToggle({ hotelId, isTest }: { hotelId: string; isTest: boolean }) {
  const [test, setTest] = useState(isTest);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setError(null);
    const next = !test;
    setTest(next);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/hotels/${hotelId}/test-flag`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isTest: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setTest(!next);
        setError(body.error ?? "Could not save that.");
      }
    } catch {
      setTest(!next);
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-sm font-medium text-slate-100">Test property</div>
        <p className="mt-1 max-w-md text-xs text-slate-400">
          {test
            ? "Left out of analytics — sandbox, fixture, or walkthrough, not a customer."
            : "Counted as a real customer in analytics."}
        </p>
        {error && <p className="mt-1 text-xs text-rose-300">{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={test}
        aria-label="Mark as a test property"
        onClick={toggle}
        disabled={pending}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition ${
          test ? "bg-amber-500" : "bg-slate-700"
        } ${pending ? "opacity-60" : ""}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
            test ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
