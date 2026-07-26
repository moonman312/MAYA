"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Per-hotel pricing-mode toggle. The switch represents LIVE:
 *   ON  (green)  → live: computed rates are pushed to the PMS each cycle.
 *   OFF (gray)   → simulation: data still syncs and prices are still computed
 *                  and shown, but nothing is written back to the PMS.
 * `simulationMode` is the current value (true = simulation / switch off).
 */
export function SimulationModeToggle({
  hotelId,
  simulationMode,
}: {
  hotelId: string;
  simulationMode: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sim, setSim] = useState(simulationMode);
  const live = !sim;

  async function toggle() {
    setError(null);
    const nextSim = !sim; // flipping the Live switch flips simulation
    setSim(nextSim);
    startTransition(async () => {
      const res = await fetch(`/api/admin/hotels/${hotelId}/simulation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulationMode: nextSim }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({ error: "Request failed" }));
        setError(b.error ?? "Request failed");
        setSim(!nextSim); // revert optimistic update
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={live}
          aria-label="Toggle live pricing"
          onClick={toggle}
          disabled={pending}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition ${
            live ? "bg-emerald-500" : "bg-slate-700"
          } ${pending ? "opacity-60" : ""}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
              live ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
        <span className="text-sm font-medium text-slate-100">
          {live ? "Live" : "Simulation"}
        </span>
        {error && <span className="text-xs text-rose-300">{error}</span>}
      </div>

      <p className="text-xs text-slate-400">
        Both modes sync data and compute prices.{" "}
        <span className="text-slate-300">Simulation</span> shows the computed prices only —
        nothing is written to the PMS.{" "}
        <span className="text-slate-300">Live</span> also pushes those rates back to the PMS
        each cycle.
      </p>

      {live && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Live: computed rates will be written to this property in the PMS. Make sure the
          rules and prices are correct first.
        </p>
      )}
    </div>
  );
}
