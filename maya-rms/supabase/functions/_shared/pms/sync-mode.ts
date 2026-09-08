/**
 * Whether a sync run pulls everything or only what changed.
 *
 * PMS-agnostic: Cloudbeds and Mews spell "changed since" differently on the
 * wire, but the decision — first run sweeps, a due interval sweeps, an explicit
 * window sweeps, everything else pulls incrementally with an overlap — is the
 * same one, and keeping two copies of it is how the two syncs would drift into
 * disagreeing about what a watermark means.
 *
 * Pure so the decision can be tested, because getting it wrong is silent in
 * both directions: too eager and a hotel's bookings stop updating, too cautious
 * and the sync never finishes for anyone above thirty rooms.
 */

export type SyncWindowDecision = {
  incremental: boolean;
  /** Pull changes since this instant (watermark minus overlap). Undefined means sweep everything. */
  modifiedSince: Date | undefined;
  reason: "first_run" | "full_sweep_due" | "window_requested" | "incremental";
};

export function decideSyncWindow(args: {
  now: Date;
  watermark: Date | null;
  lastFullSyncAt: Date | null;
  windowRequested: boolean;
  overlapMs: number;
  fullSweepIntervalMs: number;
}): SyncWindowDecision {
  const { now, watermark, lastFullSyncAt, windowRequested, overlapMs, fullSweepIntervalMs } = args;

  if (windowRequested) return { incremental: false, modifiedSince: undefined, reason: "window_requested" };
  if (!watermark) return { incremental: false, modifiedSince: undefined, reason: "first_run" };
  if (!lastFullSyncAt || now.getTime() - lastFullSyncAt.getTime() > fullSweepIntervalMs) {
    return { incremental: false, modifiedSince: undefined, reason: "full_sweep_due" };
  }

  return {
    incremental: true,
    modifiedSince: new Date(watermark.getTime() - overlapMs),
    reason: "incremental",
  };
}
