"use client";

/**
 * Which mode the property is in, at the top of every property screen (the
 * dashboard's tabs and the account pages). Simulating: a slim amber strip,
 * "Simulation · MAYA works out prices but sends nothing to Cloudbeds", with
 * Go live for a General Manager or Hotel Admin and a "?" for everyone. Live: a
 * small green "Live" tag in the same place. What it offers to whom is decided
 * in src/lib/simulation-strip.ts, from /api/property/mode.
 *
 * Go live opens the same confirm as the review card's button (GoLiveDialog)
 * and makes the same call (requestGoLive). The strip sits in the page's flow,
 * above the header, so it never covers the header or a menu; the God Mode
 * banner floats over the top and pads the page, so the two stack.
 */

import { useEffect, useState } from "react";
import { GoLiveConfirmation, GoLiveDialog, requestGoLive } from "@/components/go-live-dialog";
import { RoomCountHelp } from "@/components/room-type-settings";
import { liveHelp, liveTitle, simulationHelp, simulationStripText, type PropertyMode } from "@/lib/simulation-strip";

/** The row's width and side padding, lined up with the page under it: the dashboard's container by default. */
const DASHBOARD_WIDTH = "max-w-6xl px-[12px] sm:px-6 md:px-10";

export function SimulationStrip({
  hotelId,
  onWentLive,
  onMode,
  width = DASHBOARD_WIDTH,
}: {
  /** The property on screen, when the page knows it: the strip reads again when it changes. */
  hotelId?: string | null;
  /** Called once the switch to live has gone through. */
  onWentLive?: () => void;
  /** Told the mode whenever the strip learns it (null when it can't), so the page can word things for it. */
  onMode?: (mode: PropertyMode["mode"] | null) => void;
  /** The page's own max width and side padding, so the words line up with it. */
  width?: string;
}) {
  const ROW = `mx-auto flex flex-wrap items-center gap-x-3 gap-y-1 ${width}`;
  const [mode, setMode] = useState<PropertyMode | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [going, setGoing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = mode?.mode ?? null;
  useEffect(() => {
    onMode?.(shown);
  }, [onMode, shown]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/property/mode", { cache: "no-store" });
        const body = res.ok ? ((await res.json()) as PropertyMode) : null;
        if (alive) setMode(body && (body.mode === "simulation" || body.mode === "live") ? body : null);
      } catch {
        // Unsure means nothing to show: the strip never guesses the mode.
        if (alive) setMode(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hotelId]);

  if (!mode) return null;

  if (mode.mode === "live") {
    const help = liveHelp(mode);
    return (
      <div className={`${ROW} justify-end pt-2`} data-testid="mode-live">
        <span
          title={liveTitle(mode)}
          className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[0.6875rem] font-semibold text-emerald-300"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-400" />
          Live
        </span>
        {help ? <RoomCountHelp label="What live means here" {...help} docs="simulation" /> : null}
      </div>
    );
  }

  const [lead, rest] = simulationStripText(mode).split(" · ");
  async function goLive() {
    setGoing(true);
    setError(null);
    const failed = await requestGoLive();
    setGoing(false);
    if (failed) {
      setError(failed);
      return;
    }
    setConfirming(false);
    setMode((m) => (m ? { ...m, mode: "live", canGoLive: false } : m));
    onWentLive?.();
  }

  return (
    <div role="status" className="border-b border-amber-500/30 bg-amber-500/10 text-amber-100" data-testid="mode-simulation">
      <div className={`${ROW} py-1.5 text-xs sm:text-[0.8125rem]`}>
        <span>
          <span className="font-semibold text-amber-200">{lead}</span>
          <span className="text-amber-200/60"> · </span>
          {rest}
        </span>
        <RoomCountHelp label="What simulation means" {...simulationHelp(mode)} docs="simulation" />
        {mode.canGoLive ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            className="ml-auto cursor-pointer rounded bg-emerald-600 px-2.5 py-0.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500"
          >
            Go live
          </button>
        ) : null}
      </div>
      <GoLiveDialog
        open={confirming}
        pmsType={mode.pmsType}
        connected={mode.connected}
        windowDays={mode.windowDays}
        busy={going}
        error={error}
        onConfirm={() => void goLive()}
        onCancel={() => setConfirming(false)}
      >
        <GoLiveConfirmation />
      </GoLiveDialog>
    </div>
  );
}
