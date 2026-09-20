import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  bookingsInFrozenWindow,
  isWithinCooldown,
  loadBookingSpeedContext,
  observeForStayDate,
  resetBookingSpeedLogOnce,
  signalSetKey,
  type BookingSpeedContext,
} from "./booking-speed-provider";
import { detectSeasons } from "@/lib/observations/seasons";
import type { SlimReservationRow } from "@/lib/observations/expected-bookings";
import { indexBookingRows } from "@/lib/observations/booking-rows";
import { addDays } from "@/lib/observations/calendar";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "./fake-supabase.test";

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

describe("a reservation with several rooms is one booking", () => {
  const night = "2026-08-15";
  // A 20-room wedding booked 14 days out, keyed as Cloudbeds keys its rooms,
  // and two singles, one of them 20 days out.
  const rows: SlimReservationRow[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ stay_date: night, booking_window_days: 14, external_reservation_id: `6364686337417-${i + 1}` })),
    { stay_date: night, booking_window_days: 14, external_reservation_id: "55" },
    { stay_date: night, booking_window_days: 20, external_reservation_id: "56" },
  ];

  it("counts it once in the observation, in the fire's frozen window, and after all but one of its rooms cancel", () => {
    // Seen 14 days out over a week: the 14 to 20 day band holds all three.
    const ctx = makeContext(rows, "2026-08-01");
    expect(observeForStayDate(ctx, night, 7).recentBookings).toBe(3);
    expect(bookingsInFrozenWindow(ctx, night, "2026-07-26", "2026-08-01")).toBe(3);
    // Nineteen rooms of the wedding cancel: it is still one booking on the night.
    const thinner = makeContext(rows.filter((r) => !r.external_reservation_id!.startsWith("6364686337417-") || r.external_reservation_id === "6364686337417-7"), "2026-08-01");
    expect(bookingsInFrozenWindow(thinner, night, "2026-07-26", "2026-08-01")).toBe(3);
    // The last room goes: now the booking is gone.
    const gone = makeContext(rows.filter((r) => !r.external_reservation_id!.startsWith("6364686337417-")), "2026-08-01");
    expect(bookingsInFrozenWindow(gone, night, "2026-07-26", "2026-08-01")).toBe(2);
  });
});

describe("the row fallback, before the migration", () => {
  const localDate = "2026-09-16";
  const night = addDays(localDate, 20);
  let id = 0;
  const row = (stay: string, lead: number, ext: string, roomType = "rt1"): FakeRow => ({
    id: `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    hotel_id: "h1",
    stay_date: stay,
    room_type_id: roomType,
    booking_date: addDays(stay, -lead),
    booking_window_days: lead,
    external_reservation_id: ext,
  });

  beforeEach(() => {
    resetBookingSpeedLogOnce();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("counts bookings for the observations and rooms for the season model, per set too", async () => {
    const rows: FakeRow[] = [];
    // Three years of history: every night sells 4 rooms, one a 3-room
    // reservation booked 30 days out and a single 10 days out.
    for (let d = -(3 * 366); d < 0; d++) {
      const stay = addDays(localDate, d);
      for (let k = 1; k <= 3; k++) rows.push(row(stay, 30, `g${-d}-${k}`));
      rows.push(row(stay, 10, `s${-d}`, "rt2"));
    }
    // The night ahead took a 20-room wedding today and one single.
    for (let k = 1; k <= 20; k++) rows.push(row(night, 20, `6364686337417-${k}`));
    rows.push(row(night, 20, "55", "rt2"));
    const { client } = fakeSupabase(
      { reservations: rows, hotel_closed_periods: [], assumption_challenges: [] },
      { rpc: (fn) => new FakeRpcError(missingFunction(fn)) },
    );
    const ctx = await loadBookingSpeedContext(client as SupabaseClient, "h1", localDate, 40, new Set(), night, ["rt1", "rt2"], [["rt1", "rt2"], ["rt1"]]);
    expect(ctx).not.toBeNull();
    // Rooms for the season model: 4 a night, never 2.
    expect(ctx!.dailyDemand.every((d) => d.value === 4)).toBe(true);
    expect(ctx!.dailyDemand).toHaveLength(3 * 366);
    // Bookings for pace: the wedding and the single, against the 2 a night usually gets.
    const obs = observeForStayDate(ctx!, night, 1);
    expect(obs.recentBookings).toBe(2);
    expect(obs.expectedBookings).toBe(0);
    // A rule measuring rt1 only sees the wedding.
    const rt1 = observeForStayDate(ctx!, night, 1, ["rt1"]);
    expect(rt1.recentBookings).toBe(1);
    expect(rt1.measuredRoomTypeIds).toEqual(["rt1"]);
    // The history's grouped windows are bookings too: 2 a night, at 30 and 10 days.
    expect(ctx!.windowsByDate.get(addDays(localDate, -1))).toEqual({ n: 2, windows: [{ bw: 30, n: 1 }, { bw: 10, n: 1 }] });
  });
});
