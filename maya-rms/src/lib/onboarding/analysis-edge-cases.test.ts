/**
 * Adversarial tests for the onboarding cleaning heuristics.
 *
 * These are deliberately nasty: real-world property shapes chosen to make the
 * heuristics embarrass themselves. A false positive here is worse than a miss
 * — we're asking a hotelier to confirm something, and being confidently wrong
 * costs their trust on their first day in the product.
 */

import { describe, expect, it } from "vitest";
import {
  findClosedPeriods,
  findDuplicateRoomTypes,
  findRateOutliers,
  findSuspectRoomTypes,
  type DailyRoomNights,
  type RoomTypeStats,
} from "../../../supabase/functions/_shared/onboarding/analysis";

const TODAY = "2026-07-26";

function build(
  from: string,
  days: number,
  nights: (i: number, date: string) => number,
): DailyRoomNights[] {
  const out: DailyRoomNights[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const n = nights(i, date);
    if (n > 0) out.push({ stay_date: date, room_nights: n });
  }
  return out;
}

function rt(o: Partial<RoomTypeStats>): RoomTypeStats {
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
    ...o,
  };
}

/* ── Closed periods ──────────────────────────────────────────────────────── */

describe("closed periods: adversarial", () => {
  it("does NOT flag natural gaps at a tiny 2-room B&B", () => {
    // 2-room property at ~30% occupancy: multi-week empty stretches are just
    // Tuesday in February, not a closure. Deterministic sparse pattern.
    const series = build("2024-01-01", 900, (i) => {
      const slow = i % 365 > 300 || i % 365 < 60; // long shoulder season
      if (slow) return i % 23 === 0 ? 1 : 0; // a booking every ~3 weeks
      return i % 3 === 0 ? 2 : 1;
    });
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(0);
  });

  it("still flags a real closure at that same small property", () => {
    // Same 2-room shape, but with a genuine 6-week hard close mid-season.
    const series = build("2024-01-01", 900, (i) => {
      if (i >= 400 && i < 442) return 0; // deliberate shutdown
      return i % 3 === 0 ? 2 : 1;
    });
    const found = findClosedPeriods(series, TODAY);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].days).toBeGreaterThanOrEqual(40);
  });

  it("handles a seasonal property that closes every winter", () => {
    // Ski-inverse: beach hotel dark Nov-Mar, three years running.
    const series = build("2023-04-01", 1150, (_i, date) => {
      const m = Number(date.slice(5, 7));
      const closed = m >= 11 || m <= 3;
      return closed ? 0 : 12;
    });
    const found = findClosedPeriods(series, TODAY);
    // Each winter is a legitimate closure — we should find them, not miss them,
    // and not explode them into dozens of fragments.
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found.length).toBeLessThanOrEqual(4);
    for (const f of found) expect(f.days).toBeGreaterThan(100);
  });

  it("does not flag the ramp-up of a brand-new property", () => {
    // Opens with a trickle: a few scattered bookings, then fills in.
    const series = build("2025-06-01", 400, (i) => {
      if (i < 60) return i % 20 === 0 ? 1 : 0; // sparse opening weeks
      return 10;
    });
    expect(findClosedPeriods(series, TODAY)).toHaveLength(0);
  });

  it("respects the 14-day boundary exactly", () => {
    const thirteen = build("2025-01-01", 200, (i) => (i >= 100 && i < 113 ? 0 : 10));
    const fourteen = build("2025-01-01", 200, (i) => (i >= 100 && i < 114 ? 0 : 10));
    expect(findClosedPeriods(thirteen, TODAY)).toHaveLength(0);
    expect(findClosedPeriods(fourteen, TODAY)).toHaveLength(1);
  });

  it("survives a leap day inside the gap", () => {
    const series = build("2024-01-01", 200, (i) => (i >= 50 && i < 80 ? 0 : 8));
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].start_date).toBe("2024-02-20");
    expect(found[0].end_date).toBe("2024-03-20"); // spans Feb 29
  });

  it("does not choke on an empty or single-day series", () => {
    expect(findClosedPeriods([], TODAY)).toEqual([]);
    expect(findClosedPeriods([{ stay_date: "2025-01-01", room_nights: 3 }], TODAY)).toEqual([]);
  });
});

/* ── Suspect room types ──────────────────────────────────────────────────── */

describe("suspect room types: adversarial", () => {
  it("does NOT flag real rooms whose names merely contain a keyword", () => {
    // Every one of these is a genuine sleeping room at a real resort.
    const innocents = [
      "Poolside King",
      "Cabana Suite",
      "Spa Suite",
      "Garden Court Room",
      "Golf View Double",
      "Tennis Villa",
      "Pool View Queen",
      "Ballroom Suite",
    ];
    const stats = innocents.map((name, i) =>
      rt({ room_type_id: `rt-${i}`, name, row_count: 800 }),
    );
    const found = findSuspectRoomTypes(stats);
    expect(found.map((f) => f.name)).toEqual([]);
  });

  it("still flags the genuine non-rooms", () => {
    const stats = [
      rt({ room_type_id: "real", name: "Standard King", row_count: 5000 }),
      rt({ room_type_id: "evt", name: "Grand Event Hall", row_count: 40, median_rate: 1400 }),
      rt({ room_type_id: "court", name: "Pickleball Court Rental", row_count: 30, median_rate: 25 }),
      rt({ room_type_id: "spa", name: "Spa Treatment Room", row_count: 20, median_rate: 90 }),
      rt({ room_type_id: "park", name: "Parking Space", row_count: 60, median_rate: 15 }),
    ];
    const flagged = findSuspectRoomTypes(stats).map((f) => f.room_type_id);
    expect(flagged).toContain("evt");
    expect(flagged).toContain("court");
    expect(flagged).toContain("spa");
    expect(flagged).toContain("park");
    expect(flagged).not.toContain("real");
  });

  it("does NOT flag a legitimate low-volume penthouse", () => {
    // Boutique hotel: the penthouse is rare AND expensive — exactly the shape
    // the "tiny share at an unusual rate" rule keys on. It's a real room.
    const stats = [
      rt({ room_type_id: "std", name: "Standard Queen", row_count: 9_000, median_rate: 180 }),
      rt({ room_type_id: "dlx", name: "Deluxe King", row_count: 5_000, median_rate: 240 }),
      rt({
        room_type_id: "pent",
        name: "Penthouse Suite",
        row_count: 40, // 0.28% of nights
        median_rate: 1_200, // 5x the median room
        reservation_count: 15,
        single_night_reservations: 4,
        median_los: 3,
      }),
    ];
    const found = findSuspectRoomTypes(stats);
    expect(found.map((f) => f.room_type_id)).not.toContain("pent");
  });

  it("does not fire the single-night rule at a hostel or airport hotel", () => {
    // Everything is one night here — that's the business model, not a defect.
    const stats = [
      rt({
        room_type_id: "dorm",
        name: "6-Bed Dorm",
        reservation_count: 900,
        single_night_reservations: 900,
        median_los: 1,
      }),
      rt({
        room_type_id: "priv",
        name: "Private Twin",
        reservation_count: 300,
        single_night_reservations: 295,
        median_los: 1,
      }),
    ];
    expect(findSuspectRoomTypes(stats)).toHaveLength(0);
  });

  it("ignores inactive room types entirely", () => {
    const stats = [
      rt({ room_type_id: "a", name: "Standard King", row_count: 5000 }),
      rt({ room_type_id: "dead", name: "Event Hall", is_active: false, row_count: 10 }),
    ];
    expect(findSuspectRoomTypes(stats).map((f) => f.room_type_id)).not.toContain("dead");
  });

  it("does not crash on a hotel with a single room type and no rate data", () => {
    expect(() =>
      findSuspectRoomTypes([rt({ median_rate: null, median_los: null, row_count: 0 })]),
    ).not.toThrow();
  });
});

/* ── Duplicates ──────────────────────────────────────────────────────────── */

describe("duplicate room types: adversarial", () => {
  it("does not treat genuinely distinct names as duplicates", () => {
    const stats = [
      rt({ room_type_id: "a", name: "King Room", row_count: 500 }),
      rt({ room_type_id: "b", name: "King Suite", row_count: 0 }),
      rt({ room_type_id: "c", name: "Room 1", row_count: 200 }),
      rt({ room_type_id: "d", name: "Room 2", row_count: 0 }),
    ];
    expect(findDuplicateRoomTypes(stats)).toHaveLength(0);
  });

  it("catches punctuation and casing variants", () => {
    const stats = [
      rt({ room_type_id: "keep", name: "Deluxe King", row_count: 900 }),
      rt({ room_type_id: "dead", name: "deluxe-king", row_count: 0 }),
    ];
    const found = findDuplicateRoomTypes(stats);
    expect(found).toHaveLength(1);
    expect(found[0].deactivate_room_type_id).toBe("dead");
  });

  it("never deactivates a room type that has bookings", () => {
    const stats = [
      rt({ room_type_id: "a", name: "Standard", row_count: 900 }),
      rt({ room_type_id: "b", name: "Standard", row_count: 1 }),
    ];
    expect(findDuplicateRoomTypes(stats)).toHaveLength(0);
  });

  it("handles three-way collisions without eating the populated one", () => {
    const stats = [
      rt({ room_type_id: "keep", name: "Suite", row_count: 400 }),
      rt({ room_type_id: "d1", name: "SUITE", row_count: 0 }),
      rt({ room_type_id: "d2", name: "suite ", row_count: 0 }),
    ];
    const found = findDuplicateRoomTypes(stats);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.keep_room_type_id === "keep")).toBe(true);
  });
});

/* ── Rate outliers ───────────────────────────────────────────────────────── */

describe("rate outliers: adversarial", () => {
  it("does NOT flag a legitimate peak-event rate", () => {
    // Sold-out NYE / eclipse / F1 weekend: 8x median is aggressive but real.
    const found = findRateOutliers([
      rt({ median_rate: 300, p99_rate: 1_400, max_rate: 2_400, row_count: 4_000 }),
    ]);
    expect(found).toHaveLength(0);
  });

  it("still flags a decimal-point slip", () => {
    const found = findRateOutliers([
      rt({ median_rate: 240, p99_rate: 420, max_rate: 24_000, row_count: 4_000 }),
    ]);
    expect(found).toHaveLength(1);
  });

  it("stays quiet when every rate is identical", () => {
    expect(
      findRateOutliers([
        rt({ median_rate: 200, p99_rate: 200, max_rate: 200, row_count: 500 }),
      ]),
    ).toHaveLength(0);
  });

  it("stays quiet on thin data even with a wild max", () => {
    expect(
      findRateOutliers([rt({ row_count: 29, median_rate: 100, p99_rate: 120, max_rate: 90_000 })]),
    ).toHaveLength(0);
  });

  it("does not crash when rate stats are missing", () => {
    expect(() =>
      findRateOutliers([rt({ median_rate: null, p99_rate: null, max_rate: null })]),
    ).not.toThrow();
  });
});
