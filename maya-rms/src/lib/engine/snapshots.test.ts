/**
 * The baseline store's coverage probe must be DATE-scoped. Caught live on
 * the sandbox: a date 52 days out — beyond the tick's snapshot horizon, so
 * its own snapshots were two weeks stale — fired a pickup rule on bookings
 * that were 13 days old, because the old hotel-wide probe saw the 5-minute
 * tick's fresh near-date snapshots and synthesized a zero baseline for it.
 */
import { describe, expect, it } from "vitest";
import { makeEngineSupabaseStub } from "./golden-fixture";
import { buildBaselineSnapshotStore } from "./snapshots";

const HOTEL = "h1";
const T = "2026-08-21T12:00:00.000Z";
const FRESH = "2026-08-21T10:00:00.000Z"; // 2h before T — inside the 12h window
const STALE = "2026-08-11T10:00:00.000Z"; // 10 days before T

function snap(stay_date: string, room_type_id: string, snapshot_ts: string, booked_units = 2) {
  return {
    hotel_id: HOTEL,
    stay_date,
    room_type_id,
    snapshot_ts,
    booked_units,
    booked_revenue: booked_units * 100,
    sellable_units: 10,
  };
}

function storeFor(rows: ReturnType<typeof snap>[]) {
  const fx = makeEngineSupabaseStub({ stay_date_snapshot: rows });
  return buildBaselineSnapshotStore(fx.supabase, HOTEL, [T], "2026-08-01", "2026-12-31", ["rtA", "rtB"]);
}

describe("buildBaselineSnapshotStore coverage probe", () => {
  it("a sibling room type's fresh row at the SAME date counts as coverage", async () => {
    const store = await storeFor([snap("2026-10-15", "rtB", FRESH)]);
    expect(await store.coverageAt(T, "2026-10-15")).toBe(FRESH);
  });

  it("fresh rows at OTHER dates prove nothing for this date (the live misfire)", async () => {
    // Near dates snapshot every 5 minutes; the far date under test has only
    // a stale row of its own. Hotel-wide probing read this as fresh
    // coverage and fabricated a demand spike from old bookings.
    const store = await storeFor([
      snap("2026-08-22", "rtA", FRESH),
      snap("2026-08-23", "rtA", FRESH),
      snap("2026-10-15", "rtA", STALE),
    ]);
    expect(await store.coverageAt(T, "2026-10-15")).toBe(STALE);
  });

  it("no rows for the date at all → null → insufficient history upstream", async () => {
    const store = await storeFor([snap("2026-08-22", "rtA", FRESH)]);
    expect(await store.coverageAt(T, "2026-10-15")).toBeNull();
  });

  it("rowAt returns only rows inside the freshness window, newest per cell", async () => {
    const older = "2026-08-21T02:00:00.000Z";
    const store = await storeFor([
      snap("2026-10-15", "rtA", STALE, 9), // outside window — invisible
      snap("2026-10-15", "rtA", older, 1),
      snap("2026-10-15", "rtA", FRESH, 4),
    ]);
    expect(store.rowAt(T, "2026-10-15", "rtA")?.booked_units).toBe(4);
    expect(store.rowAt(T, "2026-10-15", "rtB")).toBeUndefined();
  });
});
