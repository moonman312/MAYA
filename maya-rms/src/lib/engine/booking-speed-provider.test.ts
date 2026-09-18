import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  bookingsInFrozenWindow,
  isWithinCooldown,
  observeForStayDate,
  signalSetKey,
  type BookingSpeedContext,
} from "./booking-speed-provider";
import { detectSeasons } from "@/lib/observations/seasons";
import type { SlimReservationRow } from "@/lib/observations/expected-bookings";
import { indexBookingRows } from "@/lib/observations/booking-rows";

function makeContext(rows: SlimReservationRow[], asOf: string): BookingSpeedContext {
  return {
    asOf,
    windowsByDate: indexBookingRows(rows),
    seasonModel: detectSeasons([]), // degenerate Year-Round model — fine for these tests
    dailyDemand: [],
    historyStart: "2023-01-01",
    historyEnd: "2026-07-27",
    isExcluded: () => false,
    selectionCache: new Map(),
    observationCache: new Map(),
  };
}

describe("isWithinCooldown", () => {
  it("throttles inside the window and frees exactly at it", () => {
    const now = "2026-07-28T12:00:00Z";
    expect(isWithinCooldown("2026-07-25T12:00:00Z", now, 7)).toBe(true);
    expect(isWithinCooldown("2026-07-21T12:00:00Z", now, 7)).toBe(false); // exactly 7 days — free
    expect(isWithinCooldown("2026-07-21T12:00:01Z", now, 7)).toBe(true); // one second short
    expect(isWithinCooldown(undefined, now, 7)).toBe(false);
    expect(isWithinCooldown("2026-07-28T11:59:00Z", now, 0)).toBe(false); // zero cooldown never throttles
  });

  it("defaults to a week, per the starter-ladder design", () => {
    expect(DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS).toBe(7);
  });
});

describe("observeForStayDate + snapshots", () => {
  const rows: SlimReservationRow[] = [];
  for (const stayDate of ["2026-08-15", "2026-08-14", "2026-08-16"]) {
    for (const w of [14, 15, 16]) rows.push({ stay_date: stayDate, booking_window_days: w });
  }

  it("memoizes per (stay date, window) and reuses the selection across windows", () => {
    const ctx = makeContext(rows, "2026-08-01");
    const a = observeForStayDate(ctx, "2026-08-15", 7);
    const b = observeForStayDate(ctx, "2026-08-15", 7);
    expect(b).toBe(a); // same object — memoized
    observeForStayDate(ctx, "2026-08-15", 30);
    expect(ctx.observationCache.size).toBe(2);
    expect(ctx.selectionCache.size).toBe(1); // one selection serves both windows
  });

  it("returns only the requested stay date's observations as audit snapshots", () => {
    const ctx = makeContext(rows, "2026-08-01");
    observeForStayDate(ctx, "2026-08-15", 7);
    observeForStayDate(ctx, "2026-08-15", 30);
    observeForStayDate(ctx, "2026-08-14", 7);
    expect(bookingSpeedAuditSnapshots(ctx, "2026-08-15")).toHaveLength(2);
    expect(bookingSpeedAuditSnapshots(ctx, "2026-08-14")).toHaveLength(1);
    expect(bookingSpeedAuditSnapshots(ctx, "2026-08-13")).toHaveLength(0);
  });

  it("flattens an observation into the compact metrics shape", () => {
    const ctx = makeContext(rows, "2026-08-01");
    const obs = observeForStayDate(ctx, "2026-08-15", 7);
    const m = bookingSpeedMetrics(obs);
    expect(m.window_days).toBe(7);
    expect(m.recent).toBe(obs.recentBookings);
    expect(m.expected).toBe(obs.expectedBookings);
    expect(typeof m.rank).toBe("number");
    expect(m.label.length).toBeGreaterThan(0);
  });
});

describe("observeForStayDate from a date (a rule that already fired on the night)", () => {
  const rows: SlimReservationRow[] = [];
  // The night got bookings 14 to 20 days out; so did the day either side.
  for (const stayDate of ["2026-08-15", "2026-08-14", "2026-08-16"]) {
    for (const w of [14, 15, 16, 17, 18, 19, 20]) rows.push({ stay_date: stayDate, booking_window_days: w });
  }

  it("counts only the days from it, keeps that apart from the whole window, and says so in the metrics", () => {
    const ctx = makeContext(rows, "2026-08-01");
    const whole = observeForStayDate(ctx, "2026-08-15", 7);
    const cut = observeForStayDate(ctx, "2026-08-15", 7, undefined, "2026-07-30");
    expect(whole.recentBookings).toBe(7);
    expect(cut.recentBookings).toBe(3);
    expect(cut.windowDays).toBe(3);
    expect(observeForStayDate(ctx, "2026-08-15", 7, undefined, "2026-07-30")).toBe(cut);
    expect(ctx.observationCache.size).toBe(2);
    const m = bookingSpeedMetrics(cut);
    expect(m).toMatchObject({ recent: 3, window_days: 3, counted_from: "2026-07-30", full_window_days: 7 });
    expect(bookingSpeedMetrics(whole)).not.toHaveProperty("counted_from");
    // Both are what the run consulted for the night.
    expect(bookingSpeedAuditSnapshots(ctx, "2026-08-15")).toHaveLength(2);
  });

  it("shares the whole window's observation when the date cuts nothing off", () => {
    const ctx = makeContext(rows, "2026-08-01");
    const whole = observeForStayDate(ctx, "2026-08-15", 7);
    expect(observeForStayDate(ctx, "2026-08-15", 7, undefined, "2026-07-26")).toBe(whole);
    expect(observeForStayDate(ctx, "2026-08-15", 7, undefined, null)).toBe(whole);
    expect(ctx.observationCache.size).toBe(1);
  });

  it("keeps a cut observation of part of the hotel on that part's cells only", () => {
    const ctx = makeContext(rows, "2026-08-01");
    ctx.hotelSetKey = signalSetKey(["rt1", "rt2"]);
    const suites = signalSetKey(["rt2"]);
    ctx.setWindows = new Map([[suites, indexBookingRows(rows.filter((r) => r.booking_window_days! <= 15))]]);
    const cut = observeForStayDate(ctx, "2026-08-15", 7, ["rt2"], "2026-07-31");
    expect(cut.recentBookings).toBe(2);
    expect(cut.measuredRoomTypeIds).toEqual(["rt2"]);
    expect(bookingSpeedAuditSnapshots(ctx, "2026-08-15")).toHaveLength(0);
    expect(bookingSpeedAuditSnapshots(ctx, "2026-08-15", new Set([suites]))).toEqual([cut]);
  });
});

describe("bookingsInFrozenWindow", () => {
  const rows: SlimReservationRow[] = [];
  // Five bookings for the night, made 14, 15, 16, 20 and 21 days before it.
  for (const w of [14, 15, 16, 20, 21]) rows.push({ stay_date: "2026-08-15", booking_window_days: w });

  it("counts what a cut observation counted, so a fire's frozen window re-reads its own bookings", () => {
    const ctx = makeContext(rows, "2026-08-01");
    const cut = observeForStayDate(ctx, "2026-08-15", 30, undefined, "2026-07-31");
    // The fire records window_from = 2026-07-31 and window_to = 2026-08-01.
    expect(cut.recentBookings).toBe(2);
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-31", "2026-08-01")).toBe(cut.recentBookings);
  });

  it("counts the bookings whose booking date is in the window, and no others", () => {
    const ctx = makeContext(rows, "2026-08-01");
    // A 7-day window ending on the day the fire was made (14 days out).
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-26", "2026-08-01")).toBe(4);
    // The same count the observation made when it fired.
    expect(observeForStayDate(ctx, "2026-08-15", 7).recentBookings).toBe(4);
    // A window a week earlier holds the two oldest bookings.
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-25", "2026-07-26")).toBe(2);
    // A single day.
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-08-01", "2026-08-01")).toBe(1);
  });

  it("answers nothing for a night this run did not load", () => {
    const ctx = makeContext(rows, "2026-08-01");
    ctx.loadedTargets = new Set(["2026-08-16"]);
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-26", "2026-08-01")).toBeNull();
  });

  it("reads the rule's own room types when it measures part of the hotel", () => {
    const ctx = makeContext(rows, "2026-08-01");
    ctx.hotelSetKey = signalSetKey(["rt1", "rt2"]);
    ctx.setWindows = new Map([[signalSetKey(["rt2"]), indexBookingRows([{ stay_date: "2026-08-15", booking_window_days: 14 }])]]);
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-26", "2026-08-01", ["rt2"])).toBe(1);
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-26", "2026-08-01", ["rt1", "rt2"])).toBe(4);
    // A set whose history this run never loaded says nothing.
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-26", "2026-08-01", ["rt3"])).toBeNull();
  });
});
