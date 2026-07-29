import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  cooldownLookbackDays,
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

describe("cooldownLookbackDays", () => {
  function bsRule(cooldownDays: number | null | undefined) {
    return { condition: { booking_speed_operator: "at_least", booking_speed_cooldown_days: cooldownDays } };
  }
  function nonBsRule() {
    return { condition: { booking_speed_operator: null, booking_speed_cooldown_days: 90 } };
  }

  it("stays at the 31-day floor when no rule configures a longer cooldown", () => {
    expect(cooldownLookbackDays([bsRule(7), bsRule(3)])).toBe(31);
    expect(cooldownLookbackDays([bsRule(null)])).toBe(31); // defaults to 7
    expect(cooldownLookbackDays([])).toBe(31);
  });

  it("extends past the floor for a rule with a longer cooldown — the actual bug", () => {
    // A 60-day cooldown whose last fire was 35 days ago used to be
    // invisible to a fixed 31-day lookback, so the rule re-fired ~25 days
    // before its own cooldown said it should.
    expect(cooldownLookbackDays([bsRule(60)])).toBe(61);
    expect(cooldownLookbackDays([bsRule(7), bsRule(60), bsRule(3)])).toBe(61);
  });

  it("ignores cooldown_days on rules that aren't booking-speed rules", () => {
    // A non-booking-speed rule's cooldown_days column (if ever populated)
    // must not stretch a horizon that exists only for booking-speed fires.
    expect(cooldownLookbackDays([nonBsRule()])).toBe(31);
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
