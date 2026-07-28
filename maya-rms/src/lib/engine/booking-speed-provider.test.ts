import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  isWithinCooldown,
  observeForStayDate,
  type BookingSpeedContext,
} from "./booking-speed-provider";
import { detectSeasons } from "@/lib/observations/seasons";
import type { SlimReservationRow } from "@/lib/observations/expected-bookings";

function makeContext(rows: SlimReservationRow[], asOf: string): BookingSpeedContext {
  const rowsByDate = new Map<string, SlimReservationRow[]>();
  for (const row of rows) {
    const list = rowsByDate.get(row.stay_date);
    if (list) list.push(row);
    else rowsByDate.set(row.stay_date, [row]);
  }
  return {
    asOf,
    rowsByDate,
    seasonModel: detectSeasons([]), // degenerate Year-Round model — fine for these tests
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
