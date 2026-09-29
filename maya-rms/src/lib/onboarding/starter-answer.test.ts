/**
 * The last onboarding question end to end: the import builds the set the
 * answer calls for from a real-looking year of bookings, keeps the other
 * sets, and an answer saved after the rules were built swaps an untouched
 * set; "Get suggestions from my data" offers the answer's set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzeImport } from "../../../supabase/functions/_shared/onboarding/analysis";
import { loadRateHistory, MAX_RATE_ROWS } from "../../../supabase/functions/_shared/onboarding/rate-moves";
import type { ImportJobRow } from "../../../supabase/functions/_shared/onboarding/worker-core";
import { fakeSupabase, type FakeCall, type FakeError, type FakeRow } from "../engine/fake-supabase.test";
import { INN, seasonal, usualLead, year, TODAY } from "./__fixtures__/rate-history";
import { starterStatsForStatus, swapStarterRulesForAnswer } from "./starter-swap";

const rank = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/lib/require-supabase-hotel", () => ({ hasHotelRank: async () => rank.allowed }));

const HOTEL = "hotel-1";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});
afterAll(() => {
  vi.useRealTimers();
});

/** An owner who adds 15% once a night is more than 70% booked and takes 10% off last-week bookings on emptier nights. */
const OWNER = year({
  types: INN,
  occupancy: seasonal,
  lead: usualLead,
  price: ({ plan, full, daysAhead }) => (full > 0.7 ? plan * 1.15 : daysAhead < 7 && full < 0.5 ? plan * 0.9 : plan),
  seed: 7,
});

/** Switched on by a test once the import has built the rules. */
const faults: { on: ((call: FakeCall) => FakeError | null) | null } = { on: null };

function hotel(opts: { answer?: string | null; rules?: FakeRow[]; simulation?: boolean } = {}) {
  const reservations = OWNER.rows.map((r, i) => ({
    id: `res-${String(i).padStart(6, "0")}`,
    hotel_id: HOTEL,
    external_reservation_id: `x${i}`,
    stay_date: r.stay_date,
    booking_date: r.booking_date,
    room_type_id: r.room_type_id,
    current_rate: r.rate,
  }));
  const perNight = new Map<string, number>();
  for (const r of OWNER.rows) perNight.set(r.stay_date, (perNight.get(r.stay_date) ?? 0) + 1);
  const daily = [...perNight].sort(([a], [b]) => (a < b ? -1 : 1)).map(([stay_date, room_nights]) => ({ stay_date, room_nights }));
  return fakeSupabase(
    {
      room_types: INN.map((t) => ({
        id: t.id,
        hotel_id: HOTEL,
        name: t.id === "std" ? "Standard" : "Suite",
        is_active: true,
        total_rooms: t.rooms,
        floor_price: 1,
        ceiling_price: 99999.99,
        counts_as_room: null,
        counts_as_room_set_by: null,
      })),
      reservations,
      hotel_settings: [
        { hotel_id: HOTEL, pricing_confidence: opts.answer ?? null, simulation_mode: opts.simulation ?? true },
      ],
      pricing_rules: opts.rules ?? [],
    },
    {
      fault: (call) => faults.on?.(call) ?? null,
      rpc: (fn) => {
        if (fn === "onboarding_daily_room_nights") return daily;
        if (fn !== "onboarding_room_type_stats") return null;
        return INN.map((t) => ({
          room_type_id: t.id,
          external_room_type_id: t.id,
          name: t.id === "std" ? "Standard" : "Suite",
          is_active: true,
          row_count: 2000,
          median_rate: t.weekday,
          p99_rate: t.weekend * 1.5,
          max_rate: t.weekend * 1.6,
          reservation_count: 900,
          single_night_reservations: 100,
          median_los: 2,
        }));
      },
    },
  );
}

function importJob(stats: Record<string, unknown> = {}): ImportJobRow {
  return {
    id: "job-1",
    hotel_id: HOTEL,
    pms_type: "cloudbeds",
    status: "running",
    phase: "analyze_early",
    window_index: 3,
    window_from: null,
    window_to: null,
    enum_cursor: {},
    row_cap: 300_000,
    max_windows: 10,
    reservations_enumerated: 0,
    rows_upserted: 0,
    windows_completed: 3,
    oldest_stay_date: null,
    newest_stay_date: null,
    attempts: 1,
    stats,
  };
}

const ruleNames = (db: ReturnType<typeof hotel>) => db.tables.pricing_rules.map((r) => String(r.name)).sort();
const LADDER = ["Hot-week surge", "Slow-date rescue", "Slow-date trim", "Sudden-spike catcher", "Warm-date bump"];

describe("the import builds the starter set the answer calls for", () => {
  it("My pricing works: the owner's own two moves, as standard rules on every day", async () => {
    const db = hotel({ answer: "automate_current" });
    const job = importJob();
    await analyzeImport(db.client, job, "early");

    expect(ruleNames(db)).toEqual(["Filling-up raise", "Last-minute cut"]);
    const fill = db.tables.pricing_rules.find((r) => r.name === "Filling-up raise")!;
    expect(fill).toMatchObject({ is_pickup_rule: false, dow_mask: 127, action_direction: "increase", action_value: 15 });
    expect(db.tables.rule_condition.find((c) => c.rule_id === fill.id)).toMatchObject({
      occupancy_operator: "gt",
      occupancy_threshold: 0.7,
    });
    const late = db.tables.pricing_rules.find((r) => r.name === "Last-minute cut")!;
    expect(db.tables.rule_condition.find((c) => c.rule_id === late.id)).toMatchObject({
      dta_operator: "lt",
      dta_threshold_days: 7,
      occupancy_operator: "lt",
      occupancy_threshold: 0.5,
    });
    // Both room types measure and change, like the ladder.
    expect(db.tables.rule_affected_room_type.filter((j) => j.rule_id === fill.id).map((j) => j.room_type_id).sort()).toEqual(["std", "suite"]);

    expect(job.stats).toMatchObject({ starterRulesFor: "automate_current" });
    expect((job.stats.starterRules as Array<{ name: string }>).map((r) => r.name)).toEqual(["Filling-up raise", "Last-minute cut"]);
    expect(job.stats.starterRulesNote).toBeUndefined();
    expect(Object.keys(job.stats.starterRuleSets as object).sort()).toEqual(["automate_current", "find_upside", "none"]);

    // The same pass again after a crash, its stats lost: the set is found on record.
    const retry = importJob();
    await analyzeImport(db.client, retry, "early");
    expect(ruleNames(db)).toEqual(["Filling-up raise", "Last-minute cut"]);
    expect(retry.stats).toMatchObject({ starterRulesFor: "automate_current" });
    expect((retry.stats.starterRules as unknown[]).length).toBe(2);
  });

  it("no answer: the usual five, with every set kept for an answer that comes later", async () => {
    const db = hotel();
    const job = importJob();
    await analyzeImport(db.client, job, "early");
    expect(ruleNames(db)).toEqual(LADDER);
    expect(job.stats.starterRulesFor).toBe("none");
    const sets = job.stats.starterRuleSets as Record<string, { rules: Array<{ name: string }> }>;
    expect(sets.automate_current.rules.map((r) => r.name)).toEqual(["Filling-up raise", "Last-minute cut"]);
  });
});

describe("answering after the rules were built", () => {
  async function built(opts: { simulation?: boolean } = {}) {
    const db = hotel({ simulation: opts.simulation });
    const job = importJob();
    await analyzeImport(db.client, job, "early");
    db.tables.onboarding_states = [{ hotel_id: HOTEL, import_job_id: "job-1", questions: { floor: 80 } }];
    db.tables.import_jobs = [{ id: "job-1", hotel_id: HOTEL, stats: job.stats }];
    // A simulated fire of the ladder, to be cleared with its rule.
    const warm = db.tables.pricing_rules.find((r) => r.name === "Warm-date bump")!;
    db.tables.pickup_event = [{ id: "pe1", hotel_id: HOTEL, rule_id: warm.id }];
    return db;
  }

  it("swaps an untouched set for the answer's, clearing what the old rules did", async () => {
    rank.allowed = true;
    const db = await built();
    expect(await swapStarterRulesForAnswer(db.client, HOTEL, "automate_current")).toEqual({
      swapped: true,
      builtFor: "automate_current",
    });
    expect(ruleNames(db)).toEqual(["Filling-up raise", "Last-minute cut"]);
    expect(db.tables.pickup_event).toHaveLength(0);

    // The status shows the swapped set, and never the other sets.
    const stats = starterStatsForStatus(db.tables.import_jobs[0].stats as Record<string, unknown>, {
      floor: 80,
      starterRulesFor: "automate_current",
    })!;
    expect((stats.starterRules as Array<{ name: string }>).map((r) => r.name)).toEqual(["Filling-up raise", "Last-minute cut"]);
    expect(stats.starterRuleSets).toBeUndefined();

    // A second answer swaps again, from the set now on the property.
    db.tables.onboarding_states[0].questions = { floor: 80, starterRulesFor: "automate_current" };
    expect(await swapStarterRulesForAnswer(db.client, HOTEL, "find_upside")).toEqual({ swapped: true, builtFor: "find_upside" });
    expect(ruleNames(db)).toEqual(LADDER);
  });

  it("leaves the rules alone once anyone has touched them, gone live, or lacks the role", async () => {
    rank.allowed = true;
    const off = await built();
    off.tables.pricing_rules[0].is_active = false;
    expect(await swapStarterRulesForAnswer(off.client, HOTEL, "automate_current")).toEqual({ swapped: false, reason: "changed" });

    const added = await built();
    added.tables.pricing_rules.push({ id: "mine", hotel_id: HOTEL, name: "My rule", is_active: true, version: 1 });
    expect(await swapStarterRulesForAnswer(added.client, HOTEL, "automate_current")).toEqual({ swapped: false, reason: "changed" });

    const live = await built({ simulation: false });
    expect(await swapStarterRulesForAnswer(live.client, HOTEL, "automate_current")).toEqual({ swapped: false, reason: "live" });
    expect(ruleNames(live)).toEqual(LADDER);

    rank.allowed = false;
    const viewer = await built();
    expect(await swapStarterRulesForAnswer(viewer.client, HOTEL, "automate_current")).toEqual({ swapped: false, reason: "not_allowed" });
    rank.allowed = true;

    const same = await built();
    expect(await swapStarterRulesForAnswer(same.client, HOTEL, null)).toEqual({ swapped: false, reason: "same" });
  });

  it("leaves the old set in place when the swap fails, and saving the answer again swaps it", async () => {
    rank.allowed = true;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failures: Array<[string, (call: FakeCall, n: number) => boolean]> = [
        ["the first new rule", (c) => c.table === "pricing_rules" && c.op === "insert"],
        ["the second new rule", (c, n) => c.table === "pricing_rules" && c.op === "insert" && n === 2],
        ["a new rule's condition", (c) => c.table === "rule_condition" && c.op === "insert"],
        ["the third old rule's delete", (c, n) => c.table === "pricing_rules" && c.op === "delete" && n === 3],
      ];
      for (const [what, when] of failures) {
        const db = await built();
        const counts = new Map<string, number>();
        faults.on = (call) => {
          const key = `${call.table}:${call.op}`;
          const n = (counts.get(key) ?? 0) + 1;
          counts.set(key, n);
          return when(call, n) ? { code: "57014", message: "canceling statement due to statement timeout" } : null;
        };
        expect(await swapStarterRulesForAnswer(db.client, HOTEL, "automate_current"), what).toEqual({
          swapped: false,
          reason: "failed",
        });
        faults.on = null;

        // The property still has the whole set the review lists, untouched.
        expect(ruleNames(db), what).toEqual(LADDER);
        expect(db.tables.pricing_rules.every((r) => r.is_active === true && r.version === 1), what).toBe(true);
        const ids = new Set(db.tables.pricing_rules.map((r) => r.id));
        expect(db.tables.rule_condition.filter((c) => ids.has(c.rule_id)), what).toHaveLength(LADDER.length);
        const shown = starterStatsForStatus(db.tables.import_jobs[0].stats as Record<string, unknown>, { floor: 80 })!;
        expect((shown.starterRules as Array<{ name: string }>).map((r) => r.name).sort(), what).toEqual(LADDER);

        // Saving the answer again swaps it.
        expect(await swapStarterRulesForAnswer(db.client, HOTEL, "automate_current"), what).toEqual({
          swapped: true,
          builtFor: "automate_current",
        });
        expect(ruleNames(db), what).toEqual(["Filling-up raise", "Last-minute cut"]);
      }
    } finally {
      faults.on = null;
      errorLog.mockRestore();
    }
  });

  it("an answer whose set is already on the property is recorded, not swapped again", async () => {
    rank.allowed = true;
    const db = await built();
    expect(await swapStarterRulesForAnswer(db.client, HOTEL, "automate_current")).toEqual({ swapped: true, builtFor: "automate_current" });
    const ids = db.tables.pricing_rules.map((r) => r.id);
    // The note of the swap was lost: the next save finds the set there.
    expect(await swapStarterRulesForAnswer(db.client, HOTEL, "automate_current")).toEqual({ swapped: true, builtFor: "automate_current" });
    expect(db.tables.pricing_rules.map((r) => r.id)).toEqual(ids);
  });

  it("does nothing before the import has built them", async () => {
    const db = hotel();
    db.tables.onboarding_states = [{ hotel_id: HOTEL, import_job_id: "job-1", questions: {} }];
    db.tables.import_jobs = [{ id: "job-1", hotel_id: HOTEL, stats: {} }];
    expect(await swapStarterRulesForAnswer(db.client, HOTEL, "automate_current")).toEqual({ swapped: false, reason: "not_built" });
  });
});

describe("Get suggestions from my data, with an answer on file", () => {
  it("offers the owner's own moves for My pricing works", async () => {
    const db = hotel({ answer: "automate_current" });
    db.tables.hotels = [{ id: HOTEL, currency: "USD" }];
    await analyzeImport(db.client, importJob({ mode: "refresh" }), "early");
    const adds = db.tables.onboarding_findings
      .filter((f) => f.kind === "rule_suggestion")
      .map((f) => (f.payload as { spec: { name: string; dow_mask?: number } }).spec);
    expect(adds.map((s) => [s.name, s.dow_mask])).toEqual([
      ["Filling-up raise", 127],
      ["Last-minute cut", 127],
    ]);
    // A refresh only ever suggests.
    expect(db.tables.pricing_rules).toHaveLength(0);
  });
});

describe("reading the past year", () => {
  it("keeps booked, priced nights of the room types asked for, before today", async () => {
    const row = (id: string, o: Partial<FakeRow>) => ({
      id,
      hotel_id: HOTEL,
      stay_date: "2026-09-01",
      booking_date: "2026-08-01",
      room_type_id: "std",
      current_rate: 150,
      ...o,
    });
    const db = fakeSupabase({
      room_types: [
        { id: "std", hotel_id: HOTEL, total_rooms: 14 },
        { id: "court", hotel_id: HOTEL, total_rooms: 2 },
      ],
      reservations: [
        row("a", {}),
        row("b", { booking_date: null }),
        row("c", { current_rate: 0 }),
        row("d", { room_type_id: "court" }),
        row("e", { stay_date: TODAY }),
        row("f", { stay_date: "2025-09-27" }),
        row("g", { hotel_id: "other" }),
      ],
    });
    const { rows, rooms } = await loadRateHistory(db.client, HOTEL, ["std"], TODAY);
    expect(rooms).toBe(14);
    expect(rows).toEqual([{ stay_date: "2026-09-01", booking_date: "2026-08-01", room_type_id: "std", rate: 150 }]);
  });

  it("stops at the cap on a whole night, newest nights first", async () => {
    const PER_NIGHT = 140;
    const reservations: FakeRow[] = [];
    const today = Date.parse(`${TODAY}T00:00:00Z`);
    for (let back = 1; back <= 365; back += 1) {
      const night = new Date(today - back * 86_400_000).toISOString().slice(0, 10);
      for (let i = 0; i < PER_NIGHT; i += 1) {
        reservations.push({
          id: `${night}-${String(i).padStart(3, "0")}`,
          hotel_id: HOTEL,
          stay_date: night,
          booking_date: night,
          room_type_id: "std",
          current_rate: 100,
        });
      }
    }
    const db = fakeSupabase({ room_types: [{ id: "std", hotel_id: HOTEL, total_rooms: 150 }], reservations });
    const { rows } = await loadRateHistory(db.client, HOTEL, ["std"], TODAY);
    const perNight = new Map<string, number>();
    for (const r of rows) perNight.set(r.stay_date, (perNight.get(r.stay_date) ?? 0) + 1);
    expect(rows.length).toBeLessThanOrEqual(MAX_RATE_ROWS);
    expect(rows.length).toBeGreaterThan(MAX_RATE_ROWS - 2 * PER_NIGHT);
    expect([...perNight.values()].every((n) => n === PER_NIGHT)).toBe(true);
    expect(perNight.has(new Date(today - 86_400_000).toISOString().slice(0, 10))).toBe(true);
  });
});
