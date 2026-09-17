import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  cooldownLookbackDays,
  isWithinCooldown,
  loadLastBookingSpeedFires,
  observeForStayDate,
  type BookingSpeedContext,
} from "./booking-speed-provider";
import { detectSeasons } from "@/lib/observations/seasons";
import type { SlimReservationRow } from "@/lib/observations/expected-bookings";
import type { EngineRule } from "@/types/domain";
import { fakeSupabase } from "./fake-supabase.test";

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

describe("loadLastBookingSpeedFires", () => {
  const NOW = "2026-09-16T12:00:00.000Z";
  const TODAY = "2026-09-16";
  const mk = (id: string, pickup: boolean, bs: boolean, cooldown: number | null = null) =>
    ({
      id,
      is_pickup_rule: pickup,
      condition: { booking_speed_operator: bs ? "at_least" : null, booking_speed_cooldown_days: cooldown },
    }) as unknown as EngineRule;

  it("sees every fire past PostgREST's 1,000-row cap, same as a full read for every key it is asked about", async () => {
    const rules = [mk("bs1", true, true), mk("bs2", true, true, 45), mk("plain", true, false), mk("ladder", false, true)];
    const events: Record<string, unknown>[] = [];
    let n = 0;
    const day = (offset: number) => new Date(Date.UTC(2026, 8, 16) + offset * 86_400_000).toISOString().slice(0, 10);
    // Older fires first (lower ids), so an unpaged read would keep only them.
    for (let back = 60; back >= 0; back--) {
      for (const ruleId of ["bs1", "bs2", "plain"]) {
        for (let d = -5; d < 20; d++) {
          if ((back + d) % 3 !== 0) continue;
          events.push({
            id: `ev${String(n++).padStart(6, "0")}`,
            hotel_id: "h1",
            rule_id: ruleId,
            stay_date: day(d),
            applied_at: new Date(Date.parse(NOW) - back * 86_400_000).toISOString(),
          });
        }
      }
    }
    expect(events.length).toBeGreaterThan(1000);

    const { client } = fakeSupabase({ pickup_event: events }, { maxRows: 1000 });
    const got = await loadLastBookingSpeedFires(client, "h1", rules, TODAY, NOW);

    // Truth: the old unfiltered read with no cap, then only the keys the
    // engine ever looks up (booking-speed pickup rules, today onward).
    const horizon = new Date(Date.parse(NOW) - 46 * 86_400_000).toISOString();
    const truth = new Map<string, string>();
    for (const f of events) {
      if (String(f.applied_at) < horizon) continue;
      const key = `${f.rule_id}|${f.stay_date}`;
      const prev = truth.get(key);
      if (!prev || String(f.applied_at) > prev) truth.set(key, String(f.applied_at));
    }
    let looked = 0;
    for (const ruleId of ["bs1", "bs2"]) {
      for (let d = 0; d < 20; d++) {
        const key = `${ruleId}|${day(d)}`;
        expect(got.get(key)).toBe(truth.get(key));
        if (truth.has(key)) looked++;
      }
    }
    expect(looked).toBeGreaterThan(20);
    for (const key of got.keys()) expect(key.startsWith("plain|")).toBe(false);
  });

  it("skips the read when no pickup rule uses booking speed", async () => {
    const { client, calls } = fakeSupabase({});
    const got = await loadLastBookingSpeedFires(client, "h1", [mk("ladder", false, true)], TODAY, NOW);
    expect(got.size).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("throws on a failed read rather than lifting every cooldown", async () => {
    const { client } = fakeSupabase({}, { fault: () => ({ message: "timeout" }) });
    await expect(loadLastBookingSpeedFires(client, "h1", [mk("bs1", true, true)], TODAY, NOW)).rejects.toThrow(/timeout/);
  });
});
