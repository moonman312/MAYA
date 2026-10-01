"use client";

/**
 * Which mode the property is in, at the top of every property screen (the
 * dashboard's tabs and the account pages). Simulating: a slim amber strip,
 * "Simulation · MAYA works out prices but sends nothing to Cloudbeds", with
 * Go live for a General Manager or Hotel Admin and a "?" for everyone. Live: a
 * small green "Live" tag in the same place. What it offers to whom is decided
 * in src/lib/simulation-strip.ts, from /api/property/mode.
 *
 * Go live opens the same confirm as the review card's button (GoLiveDialog),
 * naming the property, and makes the same call (requestGoLive) for the
 * property the strip shows. The strip sits in the page's flow, above the
 * header, so it never covers the header or a menu; the God Mode banner floats
 * over the top and pads the page, so the two stack. On the review page it
 * sits in the page's own column (`boxed`).
 */

import { useEffect, useState } from "react";
import { GoLiveConfirmation, GoLiveDialog, requestGoLive } from "@/components/go-live-dialog";
import { RoomCountHelp } from "@/components/room-type-settings";
import { usePropertyMode } from "@/components/use-property-mode";
import { liveHelp, liveTitle, simulationHelp, simulationStripText, type PropertyMode } from "@/lib/simulation-strip";

/** The row's width and side padding, lined up with the page under it: the dashboard's container by default. */
const DASHBOARD_WIDTH = "max-w-6xl px-[12px] sm:px-6 md:px-10";

export function SimulationStrip({
  hotelId,
  onWentLive,
  onMode,
  width = DASHBOARD_WIDTH,
  boxed = false,
}: {
  /** The property on screen, when the page knows it: the strip reads again when it changes. */
  hotelId?: string | null;
  /** Called once the switch to live has gone through. */
  onWentLive?: () => void;
  /** Told the mode whenever the strip learns it (null when it can't), so the page can word things for it. */
  onMode?: (mode: PropertyMode["mode"] | null) => void;
  /** The page's own max width and side padding, so the words line up with it. */
  width?: string;
  /** Inside a page's own column (the review page) rather than across the top: rounded, with room under it. */
  boxed?: boolean;
}) {
  const ROW = `mx-auto flex items-center gap-x-3 ${width}`;
  const mode = usePropertyMode(hotelId);
  const [confirming, setConfirming] = useState(false);
  const [going, setGoing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = mode?.mode ?? null;
  useEffect(() => {
    onMode?.(shown);
  }, [onMode, shown]);

  if (!mode) return null;

  if (mode.mode === "live") {
    const help = liveHelp(mode);
    return (
      <div className={`${ROW} justify-end ${boxed ? "mb-4" : "pt-2"}`} data-testid="mode-live">
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
    if (!mode) return;
    setGoing(true);
    setError(null);
    // The property this strip shows: the route refuses if the active one is another by now.
    const failed = await requestGoLive(mode.hotelId);
    setGoing(false);
    if (failed) {
      setError(failed);
      return;
    }
    setConfirming(false);
    onWentLive?.();
  }

  return (
    <div
      role="status"
      className={`bg-amber-500/20 text-amber-50 ${boxed ? "mb-4 rounded-md border border-amber-400/40" : "border-b border-amber-400/40"}`}
      data-testid="mode-simulation"
    >
      <div className={`${ROW} ${boxed ? "px-3" : ""} py-1.5 text-xs sm:text-[0.8125rem]`}>
        <span className="min-w-0 flex-1">
          <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-amber-400 align-middle" />
          <span className="font-semibold text-amber-200">{lead}</span>
          <span className="text-amber-200/70"> · </span>
          {rest}
          {/* Inline, so on a phone it ends the second line rather than taking a third. */}
          <span className="ml-1.5 inline-block align-middle">
            <RoomCountHelp label="What simulation means" {...simulationHelp(mode)} docs="simulation" />
          </span>
        </span>
        {mode.canGoLive ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            // A bigger target than the strip is tall: the negative margin keeps the strip slim.
            className="-my-1 min-h-7 shrink-0 cursor-pointer rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-500"
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
        propertyName={mode.propertyName}
        busy={going}
        error={error}
        onConfirm={() => void goLive()}
        onCancel={() => setConfirming(false)}
      >
        <GoLiveConfirmation pmsType={mode.pmsType} />
      </GoLiveDialog>
    </div>
  );
}
