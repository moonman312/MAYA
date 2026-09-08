import { describe, expect, it } from "vitest";
import {
  PACE_OCCUPANCY_MILESTONES,
  dailyPaceSeries,
  describeBookingPace,
  occupancyMilestones,
  paceScore,
} from "../../../supabase/functions/_shared/observations/booking-pace";
import type { SlimReservationRow } from "../../../supabase/functions/_shared/observations/booking-rows";

const NO_MATH_SYMBOLS = /[<>]/;

function windowRows(stayDate: string, windows: number[]): SlimReservationRow[] {
  return windows.map((w) => ({ stay_date: stayDate, booking_window_days: w }));
}

// 19 bookings against capacity 20, spread far out: 30% (6th booking) at 55
// days, 60% (12th) at 34, 80% (16th) at 26, 90% (18th) at 22, sellout never.
const FAST_WINDOWS = [80, 75, 70, 65, 60, 55, 50, 45, 40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20];

describe("occupancyMilestones", () => {
  it("uses Jake's milestone ladder by default", () => {
    expect(PACE_OCCUPANCY_MILESTONES).toEqual([0.3, 0.6, 0.8, 0.9, 1]);
  });

  it("records the days-out at which each occupancy milestone was first reached", () => {
    const milestones = occupancyMilestones(windowRows("2025-07-15", FAST_WINDOWS), "2025-07-15", 20);
    expect(milestones).toEqual([
      { threshold: 0.3, daysOut: 55 },
      { threshold: 0.6, daysOut: 34 },
      { threshold: 0.8, daysOut: 26 },
      { threshold: 0.9, daysOut: 22 },
      { threshold: 1, daysOut: null }, // 19 of 20 rooms — never sold out
    ]);
  });

  it("lets one booking at a small property register several milestones at once (at-least semantics)", () => {
    // Capacity 3: the third booking jumps occupancy from 67% straight to
    // 100%, blowing through 80, 90, and sellout in a single reservation.
    const milestones = occupancyMilestones(windowRows("2025-07-15", [30, 15, 5]), "2025-07-15", 3);
    expect(milestones).toEqual([
      { threshold: 0.3, daysOut: 30 },
      { threshold: 0.6, daysOut: 15 },
      { threshold: 0.8, daysOut: 5 },
      { threshold: 0.9, daysOut: 5 },
      { threshold: 1, daysOut: 5 },
    ]);
  });

  it("only counts rows for the requested stay date, sorts unsorted input, and accepts booking_date rows", () => {
    const rows: SlimReservationRow[] = [
      { stay_date: "2025-07-15", booking_window_days: 5 },
      { stay_date: "2025-07-16", booking_window_days: 90 }, // other date — must not count
      { stay_date: "2025-07-15", booking_date: "2025-06-15" }, // 30 days out, via booking_date
      { stay_date: "2025-07-15" }, // no booking info — skipped
    ];
    // Capacity 2: the 30-days-out booking alone reaches 30% (needs 1 room);
    // every later milestone lands on the 5-days-out booking (needs 2). If
    // the other date's 90-days-out row leaked in, 30% would read 90.
    const milestones = occupancyMilestones(rows, "2025-07-15", 2);
    expect(milestones).toEqual([
      { threshold: 0.3, daysOut: 30 },
      { threshold: 0.6, daysOut: 5 },
      { threshold: 0.8, daysOut: 5 },
      { threshold: 0.9, daysOut: 5 },
      { threshold: 1, daysOut: 5 },
    ]);
  });

  it("returns all nulls for a date with no bookings", () => {
    const milestones = occupancyMilestones([], "2025-07-15", 20);
    expect(milestones.every((m) => m.daysOut === null)).toBe(true);
    expect(paceScore(milestones)).toBe(0);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => occupancyMilestones([], "2025-07-15", 0)).toThrow();
    expect(() => dailyPaceSeries([], -1)).toThrow();
  });
});

describe("paceScore", () => {
  it("sums the milestone days-outs, with unreached milestones contributing nothing", () => {
    const milestones = occupancyMilestones(windowRows("2025-07-15", FAST_WINDOWS), "2025-07-15", 20);
    expect(paceScore(milestones)).toBe(55 + 34 + 26 + 22);
  });

  it("is monotone in demand pressure: filling earlier always scores higher", () => {
    const early = occupancyMilestones(windowRows("d", [60, 50, 40]), "d", 3);
    const late = occupancyMilestones(windowRows("d", [6, 5, 4]), "d", 3);
    expect(paceScore(early)).toBeGreaterThan(paceScore(late));
  });
});

describe("dailyPaceSeries", () => {
  it("produces one DailyDemand entry per stay date, sorted by date", () => {
    const rows = [
      ...windowRows("2025-07-16", [6, 5, 4]),
      ...windowRows("2025-07-15", [60, 50, 40]),
    ];
    const series = dailyPaceSeries(rows, 3);
    expect(series.map((d) => d.stay_date)).toEqual(["2025-07-15", "2025-07-16"]);
    expect(series[0].value).toBeGreaterThan(series[1].value);
  });

  it("is deterministic", () => {
    const rows = [...windowRows("2025-07-15", FAST_WINDOWS), ...windowRows("2025-07-16", [6, 5])];
    expect(dailyPaceSeries(rows, 20)).toEqual(dailyPaceSeries(rows, 20));
  });
});

describe("describeBookingPace", () => {
  it("reads the curve in plain words, noting the first milestone never reached", () => {
    const text = describeBookingPace(
      occupancyMilestones(windowRows("2025-07-15", FAST_WINDOWS), "2025-07-15", 20),
    );
    expect(text).toContain("30 percent booked 55 days before arrival");
    expect(text).toContain("90 percent booked 22 days before arrival");
    expect(text).toContain("It never fully booked.");
    expect(text).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("handles a fully booked date and day-of-arrival phrasing", () => {
    const text = describeBookingPace(occupancyMilestones(windowRows("d", [30, 15, 0]), "d", 3));
    expect(text).toContain("fully booked on the day of arrival");
    expect(text).not.toContain("never");
  });

  it("handles a date that never got going", () => {
    const text = describeBookingPace(occupancyMilestones([], "d", 20));
    expect(text).toBe("This date never reached 30 percent booked.");
  });
});
