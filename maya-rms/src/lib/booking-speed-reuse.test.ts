/**
 * Reusing the comparison data (what a night usually gets, and the booking
 * history behind it) never changes a day or a price. Jake, 2026-09-29: the
 * activation popup gets faster by reusing it, within one popup (its runs
 * share one reading of the history) and across popups and the scheduled
 * runs (the hotel day's store, booking_history_cache).
 *
 * On both copies of the engine, on seeded hotels (one with a room type that
 * doesn't count as a room, a closed period, a "not a fair comparison" date,
 * a rule measuring part of the hotel, and a time zone a day ahead of UTC):
 *
 *   - for rules drawn at random (new rules of every kind, edits of rules
 *     that are on, paused rules switched on), the popup's days, room type
 *     counts, nights run and touched nights are the same with the history
 *     shared and read from the store (empty, and as a scheduled run filled
 *     it) as with every run reading it afresh, whole and in the popup's
 *     three parts asked at once; the popup's two dry runs price every night
 *     alike both ways; the popup never writes the store;
 *   - a booking on a night already over, between the scheduled run that
 *     filled the store and the popup, leaves the store unread;
 *   - scheduled runs with the store, over a day and a half of ticks with
 *     bookings arriving, some on nights already over, publish the same
 *     prices and leave every table (rules' changes, fires, snapshots, the
 *     audit and its booking speed readings) exactly as runs without it,
 *     while the store is read back on most runs;
 *   - before the migration, runs price as without the store and say once
 *     that the file needs running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { dryRunCapture } from "@/lib/engine/evaluate";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "@/lib/engine/fake-supabase.test";
import { historyCacheGet } from "@/lib/engine/history-cache-rpc-model.test";
import { historyReuse, type HistoryLoad } from "@/lib/engine/booking-speed-provider";
import { previewRule, readOnlyClient, type EngineRuleRow, type EvaluateFn, type PreviewResult } from "@/lib/rule-preview";
import {
  ENGINES,
  FAMILY,
  H,
  HORIZON,
  KING,
  QUEEN,
  R,
  RT,
  SUITE,
  T0,
  T5,
  T10,
  TODAY,
  churn,
  clone,
  published,
  rng,
  ruleRow,
  seedHotel,
  uuid,
  type Tables,
} from "@/lib/rule-preview-fixture.test";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NEW = uuid("d1000000", 1);
const PART_RULE = uuid("c3000000", 1);

type Counts = { gets: number; hits: number; puts: number };

/** The fake, migrated, with PostgREST's 1,000-row reads; counting the store's reads that found something. */
function db(tables: Tables, counts?: Counts) {
  return fakeSupabase(tables, {
    maxRows: 1000,
    rpc: (fn, args, t) => {
      if (fn === "engine_run_gaps") return [];
      if (fn === "booking_history_cache_get" && counts) {
        const out = historyCacheGet(t, args as Record<string, unknown>) as { entries: Record<string, Record<string, unknown>> };
        counts.gets++;
        counts.hits += Object.values(out.entries).filter((e) => Object.keys(e).length > 0).length;
        return out;
      }
      if (fn === "booking_history_cache_put" && counts) counts.puts++;
      return undefined;
    },
  });
}

/**
 * A seeded hotel. Variant 1 adds what changes which nights are compared and
 * which bookings count: a room type that doesn't count as a room, a closed
 * period and a "not a fair comparison" date in the history, a rule that
 * measures and changes only two room types, and a time zone a day ahead of UTC.
 */
function hotel(seedNo: number, variant: number): Tables {
  const t = seedHotel(seedNo);
  if (variant === 1) {
    t.hotels = [{ id: H, timezone: "Pacific/Kiritimati" }];
    for (const rt of t.room_types) if (rt.id === FAMILY) rt.counts_as_room = false;
    t.hotel_closed_periods = [{ hotel_id: H, start_date: addDays(TODAY, -200), end_date: addDays(TODAY, -190) }];
    t.assumption_challenges = [
      { id: "c1", hotel_id: H, challenged_date: addDays(TODAY, -364), reason_key: "local_event", scope: "this_date", created_at: "2026-09-01T00:00:00.000Z" },
    ];
    t.pricing_rules.push(
      ruleRow(PART_RULE, {
        priority: 117,
        action_value: 4,
        cond: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 2 },
        signals: [KING, QUEEN],
        affected: [KING, QUEEN],
      }),
    );
  }
  return t;
}

/** Two scheduled runs with bookings arriving, then the paused rules switched off: the state at T10. */
async function settled(evaluate: EvaluateFn, seedNo: number, variant: number): Promise<Tables> {
  const d = db(hotel(seedNo, variant));
  vi.setSystemTime(new Date(T0));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await evaluate(d.client as any, H, T0, HORIZON);
  churn(d.tables, T5, 11, 8);
  vi.setSystemTime(new Date(T5));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await evaluate(d.client as any, H, T5, HORIZON);
  for (const rule of d.tables.pricing_rules) if (rule.id === R.pausedLadder || rule.id === R.pausedBs) rule.is_active = false;
  churn(d.tables, T10, 12, 8);
  return clone(d.tables);
}

const LEVELS = ["much_slower", "slower", "faster", "much_faster", "surging"];

/** A rule change drawn at random: a new rule of any kind, an edit of a rule that is on, or a paused rule switched on. */
function draw(t: Tables, r: () => number, i: number): { label: string; after: EngineRuleRow; before: EngineRuleRow | null } {
  const mode = i % 4;
  if (mode === 2) {
    const actives = t.pricing_rules.filter((x) => x.is_active);
    const stored = actives[Math.floor(r() * actives.length)];
    const patch: Record<string, unknown> = { action_value: Math.max(1, Number(stored.action_value) + (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 6))) };
    const c = ((stored.rule_condition as FakeRow[] | undefined)?.[0] ?? {}) as FakeRow;
    if (r() < 0.4 && c.booking_speed_window_days != null) patch.rule_condition = [{ ...c, booking_speed_window_days: [1, 7, 30][Math.floor(r() * 3)] }];
    else if (r() < 0.4 && c.occupancy_threshold != null) patch.rule_condition = [{ ...c, occupancy_threshold: Math.min(0.95, Number(c.occupancy_threshold) + 0.15) }];
    if (r() < 0.3) patch.rule_signal_room_type = [KING, QUEEN, SUITE].map((room_type_id) => ({ room_type_id }));
    const after = { ...stored, ...patch, version: Number(stored.version) + 1, updated_at: T10 } as unknown as EngineRuleRow;
    return { label: `edit ${stored.name} ${JSON.stringify(patch)}`, after, before: stored as EngineRuleRow };
  }
  if (mode === 3) {
    const paused = t.pricing_rules.filter((x) => !x.is_active);
    const stored = paused[Math.floor(r() * paused.length)];
    return { label: `switch on ${stored.name}`, after: { ...stored, is_active: true } as unknown as EngineRuleRow, before: null };
  }
  const kind = mode === 0 ? Math.floor(r() * 3) : 1 + Math.floor(r() * 2);
  const up = r() < 0.6;
  const cond: FakeRow = {};
  let direction = up ? "increase" : "decrease";
  if (kind === 0) Object.assign(cond, { occupancy_operator: up ? "gt" : "lt", occupancy_threshold: Math.round((0.2 + r() * 0.6) * 100) / 100 });
  if (kind === 1) {
    const level = LEVELS[Math.floor(r() * LEVELS.length)];
    const faster = ["faster", "much_faster", "surging"].includes(level);
    direction = faster ? "increase" : "decrease";
    Object.assign(cond, {
      booking_speed_operator: faster ? "at_least" : r() < 0.5 ? "at_most" : "is",
      booking_speed_level: level,
      booking_speed_window_days: [1, 7, 30][Math.floor(r() * 3)],
      booking_speed_cooldown_days: [1, 2, 3, 7][Math.floor(r() * 4)],
    });
  }
  if (kind === 2) Object.assign(cond, { pickup_operator: "gt", pickup_threshold: Math.floor(r() * 3), pickup_window_days: [1, 3, 7][Math.floor(r() * 3)], pickup_metric: "room_nights" });
  if (r() < 0.3) Object.assign(cond, { dta_operator: r() < 0.5 ? "lt" : "gt", dta_threshold_days: 5 + Math.floor(r() * 25) });
  const after = ruleRow(NEW, {
    created_at: T10,
    updated_at: T10,
    priority: 100 + Math.floor(r() * 40),
    action_type: r() < 0.7 ? "percent" : "fixed",
    action_direction: direction,
    action_value: 3 + Math.floor(r() * 20),
    cond,
    signals: r() < 0.7 ? RT : [KING, QUEEN, SUITE],
    affected: r() < 0.5 ? [KING, QUEEN] : RT,
  }) as EngineRuleRow;
  return { label: `new ${JSON.stringify(cond)} ${after.action_direction} ${after.action_type} ${after.action_value}`, after, before: null };
}

/** What the popup shows from one answer. */
const shown = (p: PreviewResult) => ({ affected: p.affected, roomTypesChanged: p.roomTypesChanged, touched: p.touched, nightsChecked: p.nightsChecked });

/** The popup's three parts, as rule-activation-client asks them (scaled to this 45-night window). */
const PARTS = [{ to: addDays(TODAY, 9) }, { from: addDays(TODAY, 10), to: addDays(TODAY, 24) }, { from: addDays(TODAY, 25) }];

/** A booking on a night already over, recorded late (the PMS catching up on yesterday). */
function lateBooking(t: Tables, n: number, at: string): void {
  const stay = addDays(TODAY, -1 - (n % 3));
  t.reservations.push({
    id: uuid("f9000000", n),
    hotel_id: H,
    external_reservation_id: `${900000 + n}:1`,
    stay_date: stay,
    room_type_id: RT[n % RT.length],
    booking_date: addDays(stay, -5),
    booking_window_days: 5,
    current_rate: 180,
    base_rate: 180,
    created_at: at,
  });
}

describe("the popup's days and prices with the comparison reused", () => {
  for (const engine of ENGINES) {
    it.each([
      [3, 0],
      [19, 1],
      [31, 1],
    ])(`hotel seed %i, variant %i, ${engine.name}`, async (seedNo, variant) => {
      engine.reset();
      const t = await settled(engine.evaluate, seedNo, variant);
      // The store as a scheduled run at the popup's instant leaves it (run on
      // a copy, so nothing else about the hotel moves).
      const filled = db(clone(t));
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await engine.evaluate(filled.client as any, H, T10, HORIZON, { history: { store: "write" } });
      const store = filled.tables.booking_history_cache ?? [];
      expect(store.length).toBeGreaterThan(0);
      const counts: Counts = { gets: 0, hits: 0, puts: 0 };
      const r = rng(seedNo * 31 + variant);
      for (let i = 0; i < 6; i++) {
        const { label, after, before } = draw(t, r, i);
        const input = { hotelId: H, after, before: before?.is_active ? before : null, at: T10, horizonDays: HORIZON };
        vi.setSystemTime(new Date(T10));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fresh = await previewRule(db(clone(t)).client as any, input, engine.evaluate, { reuse: false, store: false });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cold = await previewRule(db(clone(t), counts).client as any, input, engine.evaluate);
        const warm = db({ ...clone(t), booking_history_cache: structuredClone(store) }, counts);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hot = await previewRule(warm.client as any, input, engine.evaluate);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts = await Promise.all(PARTS.map((p) => previewRule(warm.client as any, { ...input, ...p }, engine.evaluate)));
        expect({ label, ...shown(cold) }).toEqual({ label, ...shown(fresh) });
        expect({ label, ...shown(hot) }).toEqual({ label, ...shown(fresh) });
        expect({ label, affected: parts.flatMap((p) => p.affected) }).toEqual({ label, affected: fresh.affected });
        expect(warm.tables.booking_history_cache).toEqual(store);

        // The popup's two dry runs over the whole window, sharing one reading
        // of the history and reading the store, price every night alike.
        const dry = async (tables: Tables, history?: HistoryLoad) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ro = readOnlyClient(db(tables).client as any);
          const withRule = dryRunCapture();
          const without = dryRunCapture();
          await engine.evaluate(ro, H, T10, HORIZON, { dryRun: { rule: after, watch: String(after.id), capture: withRule }, ...(history ? { history } : {}) });
          await engine.evaluate(ro, H, T10, HORIZON, { dryRun: { watch: String(after.id), capture: without }, ...(history ? { history } : {}) });
          return [withRule, without].map((c) => ({ prices: [...c.prices].sort(), unpriced: [...c.unpriced].sort(), touched: [...c.touched].sort() }));
        };
        const shared = { reuse: historyReuse(), store: "read" as const };
        expect({ label, runs: await dry({ ...clone(t), booking_history_cache: structuredClone(store) }, shared) }).toEqual({ label, runs: await dry(clone(t)) });
      }
      // The store was read back, and the popup never wrote it.
      expect(counts.hits).toBeGreaterThan(0);
      expect(counts.puts).toBe(0);

      // A booking on a night already over, after the store was filled: the
      // popup doesn't use it, and shows what it would without it.
      const later = clone(t);
      lateBooking(later, 1, T10);
      const { after } = draw(t, rng(5), 1);
      const input = { hotelId: H, after, at: T10, horizonDays: HORIZON };
      const quiet: Counts = { gets: 0, hits: 0, puts: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stale = await previewRule(db({ ...clone(later), booking_history_cache: structuredClone(store) }, quiet).client as any, input, engine.evaluate);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const afresh = await previewRule(db(clone(later)).client as any, input, engine.evaluate, { reuse: false, store: false });
      expect(shown(stale)).toEqual(shown(afresh));
      expect(quiet.gets).toBeGreaterThan(0);
      expect(quiet.hits).toBe(0);
    }, 600_000);
  }
});

/** Every table as the engine left it, run ids named by the order of the runs. */
function state(tables: Tables): Record<string, FakeRow[]> {
  const runIds = new Map((tables.evaluation_run_log ?? []).map((row, i) => [String(row.evaluation_run_id), `run ${i}`]));
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") return runIds.get(v) ?? v;
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  const out: Record<string, FakeRow[]> = {};
  for (const [name, rows] of Object.entries(tables)) {
    if (name === "booking_history_cache" || name === "evaluation_run_log") continue;
    out[name] = rows.map((row) => scrub(row) as FakeRow);
  }
  return out;
}

describe("scheduled runs with the history kept for the day", () => {
  const D1 = addDays(TODAY, 1);
  const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;
  /** Ticks over a day and a half, what arrives before each, and whether it touches a night already over. */
  const TICKS: { at: string; add?: number; late?: number; restate?: boolean; cancelPast?: boolean }[] = [
    { at: T0 },
    { at: T5, add: 6 },
    { at: T10, add: 4 },
    { at: at(TODAY, "14:15"), late: 1 },
    { at: at(TODAY, "14:20"), add: 5 },
    { at: at(TODAY, "14:25"), restate: true },
    { at: at(TODAY, "18:00"), add: 3 },
    { at: at(D1, "04:10") },
    { at: at(D1, "14:00"), add: 6 },
    { at: at(D1, "14:05"), cancelPast: true },
    { at: at(D1, "14:10"), add: 2 },
  ];

  for (const engine of ENGINES) {
    it.each([
      [7, 0],
      [19, 1],
    ])(`hotel seed %i, variant %i, ${engine.name}: every table as without the store`, async (seedNo, variant) => {
      engine.reset();
      const counts: Counts = { gets: 0, hits: 0, puts: 0 };
      const kept = db(hotel(seedNo, variant), counts);
      const afresh = db(hotel(seedNo, variant));
      let n = 0;
      for (const [i, tick] of TICKS.entries()) {
        // The same bookings arrive in both.
        const incoming: Tables = { reservations: [] };
        if (tick.add) churn(incoming, tick.at, 100 + i, tick.add);
        if (tick.late) lateBooking(incoming, ++n, tick.at);
        for (const d of [kept, afresh]) {
          d.tables.reservations.push(...structuredClone(incoming.reservations));
          if (tick.restate) {
            // The PMS moves a past booking's booking date.
            const row = d.tables.reservations.find((x) => String(x.stay_date) < TODAY && x.room_type_id === KING);
            if (row) Object.assign(row, { booking_date: addDays(String(row.stay_date), -2), booking_window_days: 2 });
          }
          if (tick.cancelPast) {
            const k = d.tables.reservations.findIndex((x) => String(x.stay_date) === addDays(TODAY, -3));
            if (k >= 0) d.tables.reservations.splice(k, 1);
          }
        }
        vi.setSystemTime(new Date(tick.at));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await engine.evaluate(kept.client as any, H, tick.at, HORIZON, { history: { store: "write" } });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await engine.evaluate(afresh.client as any, H, tick.at, HORIZON);
        expect({ tick: tick.at, state: state(kept.tables) }).toEqual({ tick: tick.at, state: state(afresh.tables) });
      }
      expect(counts.puts).toBeGreaterThan(0);
      expect(counts.hits).toBeGreaterThan(0);
    }, 600_000);
  }
});

describe("what the runs read", () => {
  it("reads the history once for every run of one popup, and only the nights ahead once a scheduled run has kept the rest", async () => {
    const engine = ENGINES[0];
    engine.reset();
    const t = await settled(engine.evaluate, 3, 0);
    vi.setSystemTime(new Date(T10));
    const reads = (calls: { table: string; payload: unknown }[], fn: string) => calls.filter((c) => c.table === `rpc:${fn}`);

    // One popup: the second run reads nothing the first already read.
    const popup = db(clone(t));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ro = readOnlyClient(popup.client as any);
    const reuse = historyReuse();
    await engine.evaluate(ro, H, T10, HORIZON, { dryRun: { capture: dryRunCapture() }, history: { reuse } });
    const once = { summary: reads(popup.calls, "booking_speed_history_summary").length, windows: reads(popup.calls, "booking_speed_windows").length };
    expect(once.summary).toBeGreaterThan(0);
    const rule = ruleRow(NEW, { created_at: T10, updated_at: T10, priority: 118, action_value: 6, cond: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 3 } });
    await engine.evaluate(ro, H, T10, HORIZON, { dryRun: { rule, capture: dryRunCapture() }, history: { reuse } });
    expect({ summary: reads(popup.calls, "booking_speed_history_summary").length, windows: reads(popup.calls, "booking_speed_windows").length }).toEqual(once);

    // A scheduled run keeps the day's history; a popup then reads no summary,
    // and booking windows only for nights from the hotel's today on.
    const scheduled = db(clone(t));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await engine.evaluate(scheduled.client as any, H, T10, HORIZON, { history: { store: "write" } });
    const later = db({ ...clone(t), booking_history_cache: structuredClone(scheduled.tables.booking_history_cache) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await engine.evaluate(readOnlyClient(later.client as any), H, T10, HORIZON, { dryRun: { capture: dryRunCapture() }, history: { store: "read" } });
    expect(reads(later.calls, "booking_speed_history_summary")).toHaveLength(0);
    const asked = reads(later.calls, "booking_speed_windows").flatMap((c) => (c.payload as { p_dates: string[] }).p_dates);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((d) => d < TODAY)).toEqual([]);
  }, 120_000);
});

describe("before the migration", () => {
  it("reads the history afresh, prices as without the store, and says so once", async () => {
    const engine = ENGINES[0];
    engine.reset();
    const t = await settled(engine.evaluate, 3, 0);
    const missing = fakeSupabase(clone(t), {
      maxRows: 1000,
      rpc: (fn) => (fn === "engine_run_gaps" ? [] : fn.startsWith("booking_history_cache_") ? new FakeRpcError(missingFunction(fn)) : undefined),
    });
    const plain = db(clone(t));
    for (const at of [T10, "2026-10-01T14:15:00.000Z"]) {
      vi.setSystemTime(new Date(at));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await engine.evaluate(missing.client as any, H, at, HORIZON, { history: { store: "write" } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await engine.evaluate(plain.client as any, H, at, HORIZON);
      expect(published(missing.tables)).toEqual(published(plain.tables));
    }
    const said = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .filter((line) => line.includes("booking_history_cache"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("99_supabase_migration_booking_history_cache_v1.sql");
  }, 120_000);
});
