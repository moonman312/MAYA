import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  bookingsInFrozenWindow,
  countsCompleteDays,
  isWithinCooldown,
  loadBookingSpeedContext,
  loadSplitWindows,
  observeForStayDate,
  resetBookingSpeedLogOnce,
  signalSetKey,
  splitKey,
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

describe("observeForStayDate for a rule that cuts: complete days only", () => {
  // Every night books one a day, 14 to 20 days out; this one also books
  // three today (14 days out on the 1st), which a cut rule doesn't read yet.
  const rows: SlimReservationRow[] = [];
  for (const stayDate of ["2026-08-15", "2026-08-14", "2026-08-16"]) {
    for (const w of [14, 15, 16, 17, 18, 19, 20, 21]) rows.push({ stay_date: stayDate, booking_window_days: w });
  }
  rows.push(...[1, 2, 3].map(() => ({ stay_date: "2026-08-15", booking_window_days: 14 })));

  it("ends the stretch yesterday on the night and its comparables, keyed apart from a raise rule's reading", () => {
    const ctx = makeContext(rows, "2026-08-01");
    const raise = observeForStayDate(ctx, "2026-08-15", 7, undefined, null, "increase");
    const cut = observeForStayDate(ctx, "2026-08-15", 7, undefined, null, "decrease");
    expect(raise.recentBookings).toBe(10);
    expect(raise.countedThrough).toBeUndefined();
    expect(cut.recentBookings).toBe(7);
    expect(cut.countedThrough).toBe("2026-07-31");
    expect(cut).not.toBe(raise);
    expect(observeForStayDate(ctx, "2026-08-15", 7, undefined, null, "decrease")).toBe(cut);
    expect(bookingSpeedMetrics(cut)).toMatchObject({ recent: 7, window_days: 7, counted_through: "2026-07-31" });
    expect(bookingSpeedMetrics(raise)).not.toHaveProperty("counted_through");
    expect(countsCompleteDays("decrease")).toBe(true);
    expect(countsCompleteDays("increase")).toBe(false);
    expect(countsCompleteDays(undefined)).toBe(false);
  });

  it("after a cut counts the complete days from the day after it, and ignores a split it was handed", () => {
    const ctx = makeContext(rows, "2026-08-01");
    // A cut on the 28th: the 29th, 30th and 31st.
    const since = observeForStayDate(ctx, "2026-08-15", 7, undefined, "2026-07-29", "decrease", "2026-07-28T00:05:00.000Z");
    expect(since.windowDays).toBe(3);
    expect(since.recentBookings).toBe(3);
    expect(since.countedFrom).toBe("2026-07-29");
    expect(since.countedSince).toBeUndefined();
    expect(since.countedAfter).toBe("cut");
    expect(since.countedThrough).toBe("2026-07-31");
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

  it("reads a window's first day split at the fire the raise counted from, as the raise counted it", () => {
    // Two bookings on the 30th (16 days out): one before a noon fire, one
    // after. A raise that counted from that fire recorded window_since.
    const noon = "2026-07-30T12:00:00.000Z";
    const split: SlimReservationRow[] = [
      ...rows.map((r) => ({ ...r, created_at: "2026-07-01T00:00:00.000Z" })),
      { stay_date: "2026-08-15", booking_window_days: 16, created_at: "2026-07-30T14:00:00.000Z" },
    ];
    const ctx = makeContext(split, "2026-08-01");
    ctx.splitWindows = new Map([[splitKey(noon, ""), indexBookingRows(split, noon)]]);
    const cut = observeForStayDate(ctx, "2026-08-15", 30, undefined, "2026-07-30", "increase", noon);
    expect(cut.recentBookings).toBe(3);
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-30", "2026-08-01", undefined, noon)).toBe(3);
    // Read whole, that day's earlier booking would keep the raise on.
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-30", "2026-08-01")).toBe(4);
    // A fire this run did not load the split for: nothing can be said.
    expect(bookingsInFrozenWindow(ctx, "2026-08-15", "2026-07-30", "2026-08-01", undefined, "2026-07-30T09:00:00.000Z")).toBeNull();
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

describe("observeForStayDate split at a fire: the day of the cell's last fire its way", () => {
  const noon = "2026-07-30T12:00:00.000Z";
  const early = "2026-07-01T00:00:00.000Z";
  // Every night got a booking 14 to 20 days out, all on the books long
  // before; and one more 16 days out (the 30th, for the 15th) that reached
  // MAYA after a fire at noon on the 30th.
  const rows: SlimReservationRow[] = [];
  for (const stayDate of ["2026-08-15", "2026-08-14", "2026-08-16"]) {
    for (const w of [14, 15, 16, 17, 18, 19, 20]) rows.push({ stay_date: stayDate, booking_window_days: w, created_at: early });
    rows.push({ stay_date: stayDate, booking_window_days: 16, created_at: "2026-07-30T14:00:00.000Z" });
  }
  const withSplit = (ctx: BookingSpeedContext) => {
    ctx.splitWindows = new Map([[splitKey(noon, ""), indexBookingRows(rows, noon)]]);
    return ctx;
  };

  it("counts the fire's day from the fire on, keys the observation by the fire, and says so in the metrics", () => {
    const ctx = withSplit(makeContext(rows, "2026-08-01"));
    const split = observeForStayDate(ctx, "2026-08-15", 7, undefined, "2026-07-30", "increase", noon);
    // The rest of the 30th (one booking), the 31st and the 1st.
    expect(split.recentBookings).toBe(3);
    expect(split.windowDays).toBe(3);
    expect(split.countedFrom).toBe("2026-07-30");
    expect(split.countedSince).toBe(noon);
    expect(split.countedAfter).toBe("raise");
    expect(observeForStayDate(ctx, "2026-08-15", 7, undefined, "2026-07-30", "increase", noon)).toBe(split);
    // The day after, with no fire to split by: the older reading, kept apart.
    const dayAfter = observeForStayDate(ctx, "2026-08-15", 7, undefined, "2026-07-31", "increase");
    expect(dayAfter.recentBookings).toBe(2);
    expect(dayAfter.countedSince).toBeUndefined();
    expect(ctx.observationCache.size).toBe(2);
    expect(bookingSpeedMetrics(split)).toMatchObject({ recent: 3, window_days: 3, counted_from: "2026-07-30", counted_since: noon, full_window_days: 7 });
    expect(bookingSpeedMetrics(dayAfter)).not.toHaveProperty("counted_since");
    expect(bookingSpeedAuditSnapshots(ctx, "2026-08-15")).toHaveLength(2);
  });

  it("refuses a fire whose day was not loaded rather than counting that day whole, and needs none when the window starts later", () => {
    const ctx = withSplit(makeContext(rows, "2026-08-01"));
    const other = "2026-07-30T09:00:00.000Z";
    expect(() => observeForStayDate(ctx, "2026-08-15", 7, undefined, "2026-07-30", "increase", other)).toThrow(/not loaded for the fire/);
    const later = observeForStayDate(ctx, "2026-08-15", 2, undefined, "2026-07-30", "increase", other);
    expect(later.countedSince).toBeUndefined();
    expect(later).toBe(observeForStayDate(ctx, "2026-08-15", 2));
  });

  it("reads the split over the rule's own room types when it measures part of the hotel", () => {
    const ctx = makeContext(rows, "2026-08-01");
    ctx.hotelSetKey = signalSetKey(["rt1", "rt2"]);
    const suites = signalSetKey(["rt2"]);
    const suiteRows = rows.filter((r) => r.booking_window_days! <= 16);
    ctx.setWindows = new Map([[suites, indexBookingRows(suiteRows)]]);
    ctx.splitWindows = new Map([[splitKey(noon, suites), indexBookingRows(suiteRows, noon)]]);
    const cut = observeForStayDate(ctx, "2026-08-15", 7, ["rt2"], "2026-07-30", "increase", noon);
    expect(cut.recentBookings).toBe(3);
    expect(cut.countedSince).toBe(noon);
    expect(cut.measuredRoomTypeIds).toEqual(["rt2"]);
    // The hotel-wide split was not loaded: a hotel-wide rule cannot read it.
    expect(() => observeForStayDate(ctx, "2026-08-15", 7, ["rt1", "rt2"], "2026-07-30", "increase", noon)).toThrow(/not loaded for the fire/);
  });
});

describe("loadSplitWindows", () => {
  const localDate = "2026-09-16";
  const night = addDays(localDate, 20);
  const noon = `${localDate}T12:00:00.000Z`;
  let id = 0;
  const row = (stay: string, lead: number, ext: string, roomType = "rt1", createdAt = "2026-01-01T00:00:00.000Z"): FakeRow => ({
    id: `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    hotel_id: "h1",
    stay_date: stay,
    room_type_id: roomType,
    booking_date: addDays(stay, -lead),
    booking_window_days: lead,
    external_reservation_id: ext,
    created_at: createdAt,
  });
  const history = () => {
    const rows: FakeRow[] = [];
    for (let d = -(3 * 366); d < 0; d++) {
      const stay = addDays(localDate, d);
      rows.push(row(stay, 30, `${10000 - d}`));
      rows.push(row(stay, 10, `${20000 - d}`, "rt2"));
    }
    // The night ahead, today: two singles before noon, and after noon a
    // single, a two-room reservation, a Suite, and a second room added to
    // a booking that was there before noon.
    rows.push(row(night, 20, "301", "rt1", `${localDate}T09:00:00.000Z`));
    rows.push(row(night, 20, "302", "rt1", `${localDate}T11:00:00.000Z`));
    rows.push(row(night, 20, "303", "rt1", `${localDate}T13:00:00.000Z`));
    rows.push(row(night, 20, "6364686337417-1", "rt1", `${localDate}T14:00:00.000Z`));
    rows.push(row(night, 20, "6364686337417-2", "rt1", `${localDate}T14:00:00.000Z`));
    rows.push(row(night, 20, "304", "rt2", `${localDate}T15:00:00.000Z`));
    rows.push(row(night, 20, "6364686337418-1", "rt1", `${localDate}T09:30:00.000Z`));
    rows.push(row(night, 20, "6364686337418-2", "rt1", `${localDate}T16:00:00.000Z`));
    // Tomorrow's night: nothing new.
    rows.push(row(addDays(night, 1), 21, "305", "rt1", `${localDate}T09:00:00.000Z`));
    return rows;
  };

  beforeEach(() => {
    resetBookingSpeedLogOnce();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "from booking_speed_windows with p_since", noSplitFunction: false },
    { name: "row by row when the function predates p_since", noSplitFunction: true },
  ])("loads the bookings first seen after each raise, in one read per set however many raises and nights: $name", async ({ noSplitFunction }) => {
    const rows = history();
    const { client, calls } = fakeSupabase(
      { reservations: rows, hotel_closed_periods: [], assumption_challenges: [] },
      noSplitFunction
        ? { rpc: (fn, args) => (fn === "booking_speed_windows" && (args as { p_since?: unknown }).p_since ? new FakeRpcError(missingFunction(fn)) : undefined) }
        : {},
    );
    const ctx = (await loadBookingSpeedContext(client as SupabaseClient, "h1", localDate, 40, new Set(), addDays(night, 1), ["rt1", "rt2"], [["rt1", "rt2"], ["rt1"]]))!;
    expect(ctx).not.toBeNull();
    const before = calls.length;
    const late = `${localDate}T15:30:00.000Z`;
    await loadSplitWindows(client as SupabaseClient, "h1", ctx, [
      { since: noon, stayDate: night, signalIds: ["rt1", "rt2"] },
      { since: noon, stayDate: addDays(night, 1), signalIds: ["rt1", "rt2"] },
      { since: noon, stayDate: night, signalIds: ["rt1"] },
      // A set already asked for this raise, and a later raise on the same set.
      { since: noon, stayDate: night, signalIds: ["rt2", "rt1"] },
      { since: late, stayDate: night, signalIds: ["rt1"] },
    ]);
    // Hotel-wide after noon: 303, the two-room reservation once, the Suite.
    // Over rt1 only: 303 and the reservation. After 15:30: only the room
    // added to a booking that was already there, which is nothing new.
    expect(ctx.splitWindows!.get(splitKey(noon, ""))).toEqual(new Map([[night, { n: 3, windows: [{ bw: 20, n: 3 }] }]]));
    expect(ctx.splitWindows!.get(splitKey(noon, signalSetKey(["rt1"])))).toEqual(new Map([[night, { n: 2, windows: [{ bw: 20, n: 2 }] }]]));
    expect(ctx.splitWindows!.get(splitKey(late, signalSetKey(["rt1"])))).toEqual(new Map());
    expect(ctx.splitWindows!.size).toBe(3);
    // Both nights were read for the hotel-wide noon raise, the one with
    // nothing new included.
    expect(ctx.splitLoaded!.get(splitKey(noon, ""))).toEqual(new Set([night, addDays(night, 1)]));
    // Two reads, one per set: every raise and night of a set in one call.
    const reads = calls.slice(before).filter((c) => c.table === "rpc:booking_speed_windows" || c.table === "reservations");
    const rpcs = reads.filter((c) => c.table === "rpc:booking_speed_windows");
    expect(rpcs).toHaveLength(2);
    const args = (c: { payload: unknown }) => c.payload as Record<string, unknown>;
    expect(rpcs.map((c) => [args(c).p_dates, args(c).p_since, args(c).p_include ?? null])).toEqual([
      [[night, addDays(night, 1)], [noon, noon], null],
      [[night, night], [noon, late], ["rt1"]],
    ]);
    expect(reads.filter((c) => c.table === "reservations")).toHaveLength(noSplitFunction ? 2 : 0);
    // Read once: asking again costs nothing.
    await loadSplitWindows(client as SupabaseClient, "h1", ctx, [{ since: noon, stayDate: night, signalIds: ["rt1", "rt2"] }]);
    expect(calls.length).toBe(before + reads.length);
    // And the observation reads the raise's day from it: the three after
    // noon on the target, against the day whole on its comparables.
    const obs = observeForStayDate(ctx, night, 7, ["rt1", "rt2"], localDate, "increase", noon);
    expect(obs.recentBookings).toBe(3);
    expect(obs.windowDays).toBe(1);
    expect(obs.countedSince).toBe(noon);
    expect(observeForStayDate(ctx, night, 7, ["rt1", "rt2"], localDate, "increase").recentBookings).toBe(6);
  });

  it("reads a raise already read for one night again for another night only, and keeps both", async () => {
    // A run's raises all share its applied_at. The open raises' tests may
    // read one night for a raise, and the rules' own counts another night
    // for the same raise: the second read must not find the first and skip.
    const rows = history();
    rows.push(row(addDays(night, 1), 21, "306", "rt1", `${localDate}T13:00:00.000Z`));
    const { client, calls } = fakeSupabase({ reservations: rows, hotel_closed_periods: [], assumption_challenges: [] });
    const ctx = (await loadBookingSpeedContext(client as SupabaseClient, "h1", localDate, 40, new Set(), addDays(night, 1), ["rt1", "rt2"], [["rt1", "rt2"]]))!;
    const before = calls.length;
    await loadSplitWindows(client as SupabaseClient, "h1", ctx, [{ since: noon, stayDate: night, signalIds: ["rt1", "rt2"] }]);
    await loadSplitWindows(client as SupabaseClient, "h1", ctx, [
      { since: noon, stayDate: night, signalIds: ["rt1", "rt2"] },
      { since: noon, stayDate: addDays(night, 1), signalIds: ["rt1", "rt2"] },
    ]);
    expect(ctx.splitWindows!.get(splitKey(noon, ""))).toEqual(
      new Map([
        [night, { n: 3, windows: [{ bw: 20, n: 3 }] }],
        [addDays(night, 1), { n: 1, windows: [{ bw: 21, n: 1 }] }],
      ]),
    );
    const rpcs = calls.slice(before).filter((c) => c.table === "rpc:booking_speed_windows");
    expect(rpcs.map((c) => (c.payload as Record<string, unknown>).p_dates)).toEqual([[night], [addDays(night, 1)]]);
    // Both nights read the raise's day from it.
    expect(observeForStayDate(ctx, addDays(night, 1), 7, ["rt1", "rt2"], localDate, "increase", noon).recentBookings).toBe(1);
    expect(observeForStayDate(ctx, night, 7, ["rt1", "rt2"], localDate, "increase", noon).recentBookings).toBe(3);
  });

  it("refuses a night the raise's day was never read for, rather than reading it as nothing new", async () => {
    const { client } = fakeSupabase({ reservations: history(), hotel_closed_periods: [], assumption_challenges: [] });
    const ctx = (await loadBookingSpeedContext(client as SupabaseClient, "h1", localDate, 40, new Set(), addDays(night, 1), ["rt1", "rt2"], [["rt1", "rt2"]]))!;
    await loadSplitWindows(client as SupabaseClient, "h1", ctx, [{ since: noon, stayDate: night, signalIds: ["rt1", "rt2"] }]);
    expect(() => observeForStayDate(ctx, addDays(night, 1), 7, ["rt1", "rt2"], localDate, "increase", noon)).toThrow(/not loaded for the fire/);
    expect(bookingsInFrozenWindow(ctx, addDays(night, 1), localDate, localDate, ["rt1", "rt2"], noon)).toBeNull();
  });

  it("throws on a failed read, never counting the fire's day whole", async () => {
    const { client } = fakeSupabase(
      { reservations: history(), hotel_closed_periods: [], assumption_challenges: [] },
      { rpc: (fn, args) => (fn === "booking_speed_windows" && (args as { p_since?: unknown }).p_since ? new FakeRpcError({ code: "57014", message: "canceling statement due to statement timeout" }) : undefined) },
    );
    const ctx = (await loadBookingSpeedContext(client as SupabaseClient, "h1", localDate, 40, new Set(), night, ["rt1", "rt2"], [["rt1", "rt2"]]))!;
    await expect(loadSplitWindows(client as SupabaseClient, "h1", ctx, [{ since: noon, stayDate: night, signalIds: ["rt1", "rt2"] }])).rejects.toThrow(
      /Failed to load booking history/,
    );
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
      for (let k = 1; k <= 3; k++) rows.push(row(stay, 30, `${10000 - d}-${k}`));
      rows.push(row(stay, 10, `${20000 - d}`, "rt2"));
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
