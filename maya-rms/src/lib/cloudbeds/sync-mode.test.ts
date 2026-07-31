/**
 * Whether a sync pulls everything or only what changed.
 *
 * Wrong in either direction and it is silent. Too eager, and a hotel's bookings
 * quietly stop updating because nothing ever looks at the ones nobody touched.
 * Too cautious, and the sync never finishes for any property above thirty rooms,
 * which is where this started.
 *
 * The modifiedFrom FORMAT is load-bearing and was established against the live
 * API, not the docs: Cloudbeds silently ignores parameters it does not know and
 * returns the full set, so a mis-formatted filter looks exactly like a working
 * one right up until it quietly syncs everything.
 */
import { describe, expect, it } from "vitest";
import { decideSyncMode } from "@/lib/cloudbeds/sync-hotel";

const NOW = new Date("2026-07-30T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

const base = {
  now: NOW,
  watermark: new Date(NOW.getTime() - 5 * 60_000),
  lastFullSyncAt: new Date(NOW.getTime() - HOUR),
  windowRequested: false,
  overlapMs: 2 * HOUR,
  fullSweepIntervalMs: DAY,
};

describe("when a full sweep is unavoidable", () => {
  it("sweeps everything on the first run, when there is no watermark", () => {
    // Nothing has been pulled, so "what changed since" has no answer.
    const m = decideSyncMode({ ...base, watermark: null });
    expect(m).toMatchObject({ incremental: false, modifiedFrom: undefined, reason: "first_run" });
  });

  it("sweeps everything once a day regardless of the watermark", () => {
    // An incremental pull can only see bookings someone touched, so anything a
    // dropped delta or a clock skew lost stays lost until something looks at
    // the lot.
    const m = decideSyncMode({ ...base, lastFullSyncAt: new Date(NOW.getTime() - DAY - 1000) });
    expect(m).toMatchObject({ incremental: false, reason: "full_sweep_due" });
  });

  it("sweeps everything when a full sweep has never been recorded", () => {
    const m = decideSyncMode({ ...base, lastFullSyncAt: null });
    expect(m.incremental).toBe(false);
  });

  it("honours an explicitly requested window in full", () => {
    // Asking for 90 days back is a deliberate re-read of a period; filtering it
    // to what changed would answer a different question.
    const m = decideSyncMode({ ...base, windowRequested: true });
    expect(m).toMatchObject({ incremental: false, reason: "window_requested" });
  });

  it("prefers the explicit window over every other reason", () => {
    expect(decideSyncMode({ ...base, windowRequested: true, watermark: null }).reason).toBe(
      "window_requested",
    );
  });
});

describe("the incremental pull", () => {
  it("filters to what changed once there is a watermark and a recent full sweep", () => {
    const m = decideSyncMode(base);
    expect(m.incremental).toBe(true);
    expect(m.modifiedFrom).toBeDefined();
  });

  it("reaches back past the watermark by the overlap", () => {
    // Their clock is not ours, and a booking can be written while a sweep is
    // already running. Overlapping re-reads a few unchanged rows; not
    // overlapping loses a booking until the next full sweep.
    const m = decideSyncMode(base);
    const asked = Date.parse(m.modifiedFrom!.replace(" ", "T") + "Z");
    expect(base.watermark.getTime() - asked).toBe(base.overlapMs);
  });

  it("formats the filter the way Cloudbeds actually accepts", () => {
    // Verified live: `YYYY-MM-DD HH:MM:SS` works, ISO-8601 with T and Z does
    // not. And because unknown or unparseable parameters are IGNORED rather
    // than rejected, getting this wrong would silently sync everything and look
    // like it was working.
    const m = decideSyncMode(base);
    expect(m.modifiedFrom).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(m.modifiedFrom).not.toContain("T");
    expect(m.modifiedFrom).not.toContain("Z");
    expect(m.modifiedFrom).not.toContain(".");
  });

  it("stays incremental right up to the full-sweep boundary", () => {
    const m = decideSyncMode({ ...base, lastFullSyncAt: new Date(NOW.getTime() - DAY + 1000) });
    expect(m.incremental).toBe(true);
  });
});
