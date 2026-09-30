/**
 * The app's half of the analytics panel's revenue numbers: pricing what
 * analytics_now hands back (the brackets live here, never in SQL), shaping what
 * analytics_range hands back, and the nightly snapshot's rows. What the two
 * SQL functions count, and that it is what the page counted before, is proven
 * on a real schema in command-center-speed-migration-sql.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  AnalyticsMigrationMissing,
  loadAnalyticsNow,
  loadAnalyticsRange,
  monthlyListCents,
  monthlyNetCents,
  priceNow,
  shapeRange,
  snapshotHotelMetrics,
  type AnalyticsNowRow,
} from "./analytics";

describe("monthly money", () => {
  it("divides annual back to a month-equivalent", () => {
    expect(monthlyListCents(24, "year")).toBe(Math.round(Math.round(24 * 500 * 12 * 0.9) / 12));
    expect(monthlyListCents(24, "month")).toBe(12000);
  });

  it("nets a percent code and floors an amount code at zero", () => {
    expect(monthlyNetCents(12000, { kind: "percent_off", percent_off: 75, amount_off_cents: null })).toBe(3000);
    expect(monthlyNetCents(11000, { kind: "amount_off", percent_off: null, amount_off_cents: 100000 })).toBe(0);
    expect(monthlyNetCents(12000, { kind: "trial", percent_off: null, amount_off_cents: null })).toBe(12000);
    expect(monthlyNetCents(12000, null)).toBe(12000);
  });
});

describe("priceNow", () => {
  const sub = (over: Partial<AnalyticsNowRow["subs"][number]>): AnalyticsNowRow["subs"][number] => ({
    hotel_id: "h",
    status: "active",
    billing_interval: "month",
    billed_rooms: 24,
    code_kind: null,
    percent_off: null,
    amount_off_cents: null,
    simulating: false,
    ...over,
  });
  const empty = { card_trouble: [], room_shortfall: [], sync_broken: [], engine_silent: [] };

  it("prices paying subscriptions with the app's brackets, and a trial as potential only", () => {
    const now = priceNow({
      ...empty,
      subs: [
        // Postgres numerics arrive as strings through some clients.
        sub({ hotel_id: "a", percent_off: "20.00", code_kind: "percent_off" }),
        sub({ hotel_id: "b", status: "past_due", billed_rooms: 90, simulating: true }),
        sub({ hotel_id: "c", status: "trialing", billing_interval: "year", billed_rooms: 45, code_kind: "amount_off", amount_off_cents: 5000 }),
        sub({ hotel_id: "d", status: "canceled" }),
      ],
    });
    const a = monthlyListCents(24, "month");
    const b = monthlyListCents(90, "month");
    const c = monthlyListCents(45, "year");
    expect(now.payingCount).toBe(2);
    expect(now.listMrrCents).toBe(a + b);
    expect(now.netMrrCents).toBe(Math.round(a * 0.8) + b);
    expect(now.trialingCount).toBe(1);
    expect(now.trialPotentialCents).toBe(c - 5000);
    expect(now.byBracket.find((x) => x.label === "21–40")).toEqual({ label: "21–40", count: 1, netMrrCents: Math.round(a * 0.8) });
    expect(now.byBracket.find((x) => x.label === "81–500")).toEqual({ label: "81–500", count: 1, netMrrCents: b });
    // Served = paying or trialing; the canceled one is on neither side.
    expect([now.liveCount, now.simulationCount]).toEqual([2, 1]);
  });

  it("names the attention list the way the database ordered it", () => {
    const now = priceNow({
      subs: [],
      card_trouble: [{ hotel_id: "a", name: "Alder" }],
      room_shortfall: [{ hotel_id: "b", name: "Birch" }],
      sync_broken: [{ hotel_id: "c", name: "Cedar", pms_type: "cloudbeds", status: "error" }],
      engine_silent: [{ hotel_id: "d", name: "Dogwood" }],
    });
    expect(now.attention).toEqual({
      cardTrouble: [{ hotelId: "a", name: "Alder" }],
      roomShortfall: [{ hotelId: "b", name: "Birch" }],
      syncBroken: [{ hotelId: "c", name: "Cedar", pmsType: "cloudbeds", status: "error" }],
      engineSilent: [{ hotelId: "d", name: "Dogwood" }],
    });
  });
});

describe("shapeRange", () => {
  it("turns analytics_range's answer into the page's shape", () => {
    const r = shapeRange({
      series: [{ day: "2026-09-01", list_mrr_cents: 100, net_mrr_cents: 80, paying: 2, trialing: 1 }],
      new_paying: [{ hotel_id: "h1", name: "One", day: "2026-09-02" }],
      won_back: [],
      churned: [{ hotel_id: "h2", name: "Two", day: "2026-09-03" }],
      accounts: 5,
      paid: 3,
      connected: 2,
      finished: 1,
      median_hours_to_live: 7.5,
    });
    expect(r).toEqual({
      series: [{ day: "2026-09-01", listMrrCents: 100, netMrrCents: 80, paying: 2, trialing: 1 }],
      newPaying: [{ hotelId: "h1", name: "One", day: "2026-09-02" }],
      wonBack: [],
      churned: [{ hotelId: "h2", name: "Two", day: "2026-09-03" }],
      funnel: [
        { stage: "Accounts created", count: 5 },
        { stage: "Paid (checkout done)", count: 3 },
        { stage: "PMS connected", count: 2 },
        { stage: "Onboarding finished", count: 1 },
      ],
      medianHoursToLive: 7.5,
    });
  });
});

describe("one call each", () => {
  function rpcSpy(answer: { data: unknown; error: { code?: string; message: string } | null }) {
    const calls: [string, unknown][] = [];
    return {
      calls,
      client: { rpc: async (name: string, args: unknown) => (calls.push([name, args]), answer) } as never,
    };
  }

  it("asks analytics_range for the window and whether to count test properties", async () => {
    const spy = rpcSpy({ data: { series: [], new_paying: [], won_back: [], churned: [], accounts: 0, paid: 0, connected: 0, finished: 0, median_hours_to_live: null }, error: null });
    await loadAnalyticsRange(spy.client, "2026-08-01", "2026-08-05", { includeTest: false });
    await loadAnalyticsRange(spy.client, "2026-08-01", "2026-08-05", { includeTest: true });
    expect(spy.calls).toEqual([
      ["analytics_range", { p_from: "2026-08-01", p_to: "2026-08-05", p_include_test: false }],
      ["analytics_range", { p_from: "2026-08-01", p_to: "2026-08-05", p_include_test: true }],
    ]);
  });

  it("says which file to run when the database has not got the functions yet", async () => {
    const spy = rpcSpy({ data: null, error: { code: "PGRST202", message: "Could not find the function public.analytics_now" } });
    await expect(loadAnalyticsNow(spy.client, { includeTest: false })).rejects.toBeInstanceOf(AnalyticsMigrationMissing);
    await expect(loadAnalyticsRange(spy.client, "2026-08-01", "2026-08-05", { includeTest: false })).rejects.toThrow(
      /99_supabase_migration_command_center_speed_v1\.sql/,
    );
  });

  it("passes any other failure on", async () => {
    const spy = rpcSpy({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    await expect(loadAnalyticsNow(spy.client, { includeTest: false })).rejects.toThrow(/analytics_now: canceling statement/);
  });
});

describe("snapshotHotelMetrics", () => {
  /** Answers each table from a list, paging it like PostgREST, and records the reads and the write. */
  function fakeAdmin(tables: Record<string, Record<string, unknown>[]>) {
    const reads: { table: string; order: string | null; from: number }[] = [];
    let written: Record<string, unknown>[] = [];
    const from = (table: string) => {
      let order: string | null = null;
      let ids: string[] | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        order: (col: string) => ((order = col), b),
        in: (_col: string, v: string[]) => ((ids = v), b),
        range: async (a: number, z: number) => {
          reads.push({ table, order, from: a });
          return { data: (tables[table] ?? []).slice(a, z + 1), error: null };
        },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: (tables[table] ?? []).filter((r) => !ids || ids.includes(String(r.id))), error: null }).then(res),
        upsert: async (rows: Record<string, unknown>[]) => {
          written = rows;
          return { error: null };
        },
      };
      return b;
    };
    return { admin: { from } as never, reads, written: () => written };
  }

  it("writes one row per subscription, flagged test or not, priced and netted", async () => {
    const fake = fakeAdmin({
      hotels: [
        { id: "h1", is_test: false },
        { id: "h2", is_test: true },
        { id: "h3", is_test: false },
      ],
      hotel_subscriptions: [
        { hotel_id: "h1", status: "active", billing_interval: "month", billed_rooms: 24, plan_kind: "stripe", signup_code_id: "c1" },
        { hotel_id: "h2", status: "trialing", billing_interval: "month", billed_rooms: 10, plan_kind: "stripe", signup_code_id: null },
        { hotel_id: "h3", status: "active", billing_interval: "month", billed_rooms: 12, plan_kind: "internal", signup_code_id: null },
      ],
      hotel_settings: [{ hotel_id: "h1", simulation_mode: true }],
      signup_codes: [{ id: "c1", kind: "percent_off", percent_off: 50, amount_off_cents: null }],
    });
    expect(await snapshotHotelMetrics(fake.admin, "2026-09-30")).toBe(3);
    const list = monthlyListCents(24, "month");
    expect(fake.written()).toEqual([
      { day: "2026-09-30", hotel_id: "h1", status: "active", entitled: true, plan_kind: "stripe", rooms: 24, list_mrr_cents: list, net_mrr_cents: list / 2, simulation: true, is_test: false },
      { day: "2026-09-30", hotel_id: "h2", status: "trialing", entitled: true, plan_kind: "stripe", rooms: 10, list_mrr_cents: 0, net_mrr_cents: 0, simulation: false, is_test: true },
      { day: "2026-09-30", hotel_id: "h3", status: "active", entitled: false, plan_kind: "internal", rooms: 12, list_mrr_cents: 0, net_mrr_cents: 0, simulation: false, is_test: false },
    ]);
  });

  it("pages every read in a stable order, so no hotel is skipped past the first 1000", async () => {
    const hotels = Array.from({ length: 1500 }, (_, i) => ({ id: `h${String(i).padStart(4, "0")}`, is_test: false }));
    const fake = fakeAdmin({
      hotels,
      hotel_subscriptions: hotels.map((h) => ({ hotel_id: h.id, status: "active", billing_interval: "month", billed_rooms: 5, plan_kind: "stripe", signup_code_id: null })),
      hotel_settings: [],
    });
    expect(await snapshotHotelMetrics(fake.admin, "2026-09-30")).toBe(1500);
    for (const table of ["hotels", "hotel_subscriptions"]) {
      expect(fake.reads.filter((r) => r.table === table).map((r) => r.from)).toEqual([0, 1000]);
      expect(fake.reads.filter((r) => r.table === table).every((r) => r.order != null)).toBe(true);
    }
  });
});
