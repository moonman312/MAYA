import { describe, expect, it } from "vitest";
import {
  findClosedPeriods,
  findDuplicateRoomTypes,
  findRateOutliers,
  findSuspectRoomTypes,
  type DailyRoomNights,
  type RoomTypeStats,
} from "../../../supabase/functions/_shared/onboarding/analysis";

function seriesRange(
  from: string,
  days: number,
  nights: (i: number) => number,
): DailyRoomNights[] {
  const out: DailyRoomNights[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const n = nights(i);
    if (n > 0) out.push({ stay_date: d.toISOString().slice(0, 10), room_nights: n });
  }
  return out;
}

describe("findClosedPeriods", () => {
  const TODAY = "2026-07-26";

  it("flags a mid-series 3-week dead zone with busy shoulders", () => {
    // 60 busy days, 21 zero days, 60 busy days
    const series = seriesRange("2025-01-01", 141, (i) =>
      i >= 60 && i < 81 ? 0 : 20,
    );
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].start_date).toBe("2025-03-02");
    expect(found[0].days).toBe(21);
  });

  it("ignores short gaps", () => {
    const series = seriesRange("2025-01-01", 100, (i) => (i >= 50 && i < 60 ? 0 : 15));
    expect(findClosedPeriods(series, TODAY)).toHaveLength(0);
  });

  it("does not flag pre-opening leading zeros", () => {
    // Data starts with the first reservation — leading emptiness never appears
    // in the series, and a gap touching the series start is skipped.
    const series = seriesRange("2025-06-01", 60, (i) => (i < 20 ? 0 : 12)).filter(
      (s) => s.room_nights > 0,
    );
    expect(findClosedPeriods(series, TODAY)).toHaveLength(0);
  });

  it("does not flag a trailing gap that reaches today", () => {
    // Busy history, then silence right up to today (e.g. seasonal close ongoing)
    const series = seriesRange("2026-01-01", 150, (i) => (i < 120 ? 18 : 0));
    const found = findClosedPeriods(series, "2026-05-31");
    expect(found).toHaveLength(0);
  });

  it("requires activity on both sides", () => {
    // Zeros then busy — no 'before' activity, so not a closure
    const series = seriesRange("2025-01-01", 120, (i) => (i < 30 ? 1 : i < 60 ? 0 : 20));
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1); // before-median is 1 (>0), so it IS flagged
    // now make the before side truly dead
    const series2 = seriesRange("2025-01-01", 120, (i) => (i === 0 ? 1 : i < 60 ? 0 : 20));
    expect(findClosedPeriods(series2, TODAY)).toHaveLength(0);
  });
});

function rt(overrides: Partial<RoomTypeStats>): RoomTypeStats {
  return {
    room_type_id: "rt-1",
    external_room_type_id: "X1",
    name: "Standard King",
    is_active: true,
    row_count: 1000,
    median_rate: 150,
    p99_rate: 300,
    max_rate: 350,
    reservation_count: 400,
    single_night_reservations: 80,
    median_los: 2.5,
    ...overrides,
  };
}

describe("findSuspectRoomTypes", () => {
  it("flags by name keyword", () => {
    const found = findSuspectRoomTypes([
      rt({}),
      rt({ room_type_id: "rt-2", name: "Pickleball Court" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].room_type_id).toBe("rt-2");
    expect(found[0].reasons[0]).toContain("bedroom");
  });

  it("uses tiny-share-at-odd-rate only to corroborate, never to accuse", () => {
    // On its own this shape is indistinguishable from a rare, pricey suite,
    // so it must not flag alone — but it should enrich a real finding.
    const alone = findSuspectRoomTypes([
      rt({ row_count: 10_000 }),
      rt({ room_type_id: "rt-2", name: "Mystery Space", row_count: 20, median_rate: 20 }),
    ]);
    expect(alone.map((f) => f.room_type_id)).not.toContain("rt-2");

    const corroborated = findSuspectRoomTypes([
      rt({ row_count: 10_000 }),
      rt({ room_type_id: "rt-3", name: "Parking Space", row_count: 20, median_rate: 20 }),
    ]);
    const hit = corroborated.find((f) => f.room_type_id === "rt-3");
    expect(hit).toBeDefined();
    expect(hit!.reasons.length).toBe(2);
  });

  it("flags all-single-night patterns when the hotel isn't", () => {
    const found = findSuspectRoomTypes([
      rt({}),
      rt({ room_type_id: "rt-2", name: "Day Room A", reservation_count: 40, single_night_reservations: 40 }),
    ]);
    expect(found.map((f) => f.room_type_id)).toContain("rt-2");
  });

  it("leaves a normal room type alone", () => {
    expect(findSuspectRoomTypes([rt({}), rt({ room_type_id: "rt-2", name: "Deluxe Queen" })])).toHaveLength(0);
  });
});

describe("findDuplicateRoomTypes", () => {
  it("deactivates the empty twin", () => {
    const found = findDuplicateRoomTypes([
      rt({ room_type_id: "keep", name: "Standard King", row_count: 900 }),
      rt({ room_type_id: "dead", name: "standard-king", row_count: 0 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].keep_room_type_id).toBe("keep");
    expect(found[0].deactivate_room_type_id).toBe("dead");
  });

  it("leaves duplicates alone when both have bookings", () => {
    expect(
      findDuplicateRoomTypes([
        rt({ room_type_id: "a", name: "Standard King", row_count: 900 }),
        rt({ room_type_id: "b", name: "Standard King", row_count: 100 }),
      ]),
    ).toHaveLength(0);
  });
});

describe("findRateOutliers", () => {
  it("flags a max rate far beyond p99", () => {
    const found = findRateOutliers([
      rt({ max_rate: 15_000, p99_rate: 300, median_rate: 150 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].max_rate).toBe(15_000);
  });

  it("stays quiet on thin data", () => {
    expect(
      findRateOutliers([rt({ row_count: 10, max_rate: 15_000 })]),
    ).toHaveLength(0);
  });

  it("stays quiet on normal spreads", () => {
    expect(findRateOutliers([rt({})])).toHaveLength(0);
  });
});
