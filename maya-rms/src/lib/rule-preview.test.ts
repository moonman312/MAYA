/**
 * The activation popup's count and calendar are what Apply then does, and
 * Skip moves no price.
 *
 * For every kind of change (a new standard rule, one with a days-before-
 * arrival condition, a new booking speed rule, a new pickup count rule, a
 * rule a stronger one covers, a rule over typed prices and a comp night, a
 * paused rule of each kind switched back on with changes still on the
 * price, and an edit to a rule that is on), on both copies of the engine:
 *
 *   - the nights previewRule finds (with its shortcuts, whole or in chunks)
 *     are exactly the nights where a full dry run with the change differs
 *     from a full dry run without it;
 *   - Apply (the rule saved on, then a real run at the same instant)
 *     changes exactly those nights' prices, and no others;
 *   - Skip (the rule saved on with save_rule's holds and skip_at, then real
 *     runs) leaves those nights' prices as they are, and every other night
 *     prices exactly as Apply does. A held night is let go only once the
 *     rule stops being true there and then becomes true again, and a
 *     booking speed or pickup rule counts the bookings made before it was
 *     created, with Apply and with Skip alike (Jake, 2026-09-29).
 *
 * Saving is simulated on the in-memory database the way save_rule writes it
 * (rule-activation-sql.test.ts runs save_rule itself in Postgres).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { dryRunCapture } from "@/lib/engine/evaluate";
import type { FarOutCutFacts } from "@/lib/rule-form";
import {
  farOutCutOfRow,
  nightsInScope,
  previewRule,
  readOnlyClient,
  skipPlanForRule,
  type EngineRuleRow,
  type EvaluateFn,
  type PreviewResult,
  type SkipMark,
  type SkipPlan,
} from "@/lib/rule-preview";
import {
  ENGINES,
  FAMILY,
  rng,
  H,
  HORIZON,
  KING,
  QUEEN,
  R,
  RT,
  SUITE,
  T10,
  TODAY,
  TZ,
  clone,
  fake,
  nightsDiffering,
  published,
  ruleRow,
  settle,
  uuid,
  type Tables,
} from "@/lib/rule-preview-fixture.test";
import type { FakeRow } from "@/lib/engine/fake-supabase.test";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NEW = uuid("d1000000", 1);
const T11 = "2026-10-01T14:11:00.000Z";
const T20 = "2026-10-01T14:20:00.000Z";
const T30 = "2026-10-01T14:30:00.000Z";
const T40 = "2026-10-01T14:40:00.000Z";
const T50 = "2026-10-01T14:50:00.000Z";
/** The next day, when a pickup count has a snapshot from before its day began. */
const D1 = "2026-10-02";
const D1_00 = "2026-10-02T14:00:00.000Z";
const D1_01 = "2026-10-02T14:01:00.000Z";
const D1_05 = "2026-10-02T14:05:00.000Z";
const D1_10 = "2026-10-02T14:10:00.000Z";
const D1_12 = "2026-10-02T14:12:00.000Z";
const D1_20 = "2026-10-02T14:20:00.000Z";
const D1_30 = "2026-10-02T14:30:00.000Z";
const WINDOW = Array.from({ length: HORIZON }, (_, i) => addDays(TODAY, i));

type Case = {
  name: string;
  /** The rule as it will be after Apply. */
  after: (t: Tables) => FakeRow;
  /** Extra state before the change. */
  setup?: (t: Tables) => void;
  /** At least one night changes. */
  changes?: boolean;
  /** A cut on low pickup with no days-before-arrival condition: what the popup adds (A4). */
  farOutCut?: FarOutCutFacts;
};

const created = { created_at: T10, updated_at: T10 };
const edited = (t: Tables, id: string, patch: Record<string, unknown>): FakeRow => {
  const stored = t.pricing_rules.find((r) => r.id === id)!;
  return { ...stored, ...patch, version: Number(stored.version) + 1, updated_at: T10 };
};

const CASES: Case[] = [
  {
    name: "a new standard rule",
    after: () => ruleRow(NEW, { ...created, action_value: 8, cond: { occupancy_operator: "gt", occupancy_threshold: 0.35 } }),
    changes: true,
  },
  {
    name: "a new standard rule with a days-before-arrival condition, as a fixed cut",
    after: () =>
      ruleRow(NEW, { ...created, action_type: "fixed", action_direction: "decrease", action_value: 14, cond: { occupancy_operator: "lt", occupancy_threshold: 0.5, dta_operator: "lt", dta_threshold_days: 21 } }),
    changes: true,
  },
  {
    name: "a new booking speed rule",
    after: () =>
      ruleRow(NEW, { ...created, priority: 118, action_value: 6, cond: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 3 } }),
  },
  {
    name: "a new pickup count rule",
    after: () => ruleRow(NEW, { ...created, priority: 119, action_value: 5, cond: { pickup_operator: "gt", pickup_threshold: 0, pickup_window_days: 1, pickup_metric: "room_nights" } }),
  },
  {
    name: "a new cut on low pickup with no days-before-arrival condition",
    after: () =>
      ruleRow(NEW, {
        ...created,
        priority: 121,
        action_direction: "decrease",
        action_value: 4,
        cond: { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
      }),
    // Its wait: low pickup holds the day chosen to the week of its window.
    farOutCut: { threshold: 1, windowDays: 7, metric: "room_nights", waitDays: 7 },
  },
  {
    name: "a new raise a stronger raise covers",
    after: () =>
      ruleRow(NEW, { ...created, priority: 90, action_value: 3, cond: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 30, booking_speed_cooldown_days: 7 } }),
  },
  {
    name: "a new rule over a typed price and a comp night",
    after: () => ruleRow(NEW, { ...created, action_value: 12, cond: { dta_operator: "lt", dta_threshold_days: 10 }, affected: [KING, QUEEN] }),
    setup: (t) => {
      t.manual_price.push({ hotel_id: H, stay_date: addDays(TODAY, 5), room_type_id: KING, price: 150, set_by: null, set_at: "2026-10-01T13:00:00.000Z", cleared_at: null, source: "maya" });
    },
    changes: true,
  },
  {
    name: "a paused standard rule switched back on",
    after: (t) => ({ ...t.pricing_rules.find((r) => r.id === R.pausedLadder)!, is_active: true }),
  },
  {
    name: "a paused booking speed rule switched back on",
    after: (t) => ({ ...t.pricing_rules.find((r) => r.id === R.pausedBs)!, is_active: true }),
  },
  {
    name: "an edit to a standard rule that is on: a new bar and amount, and a room type taken off",
    after: (t) =>
      edited(t, R.busy, {
        action_value: 20,
        rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.7 }],
        rule_affected_room_type: [KING, QUEEN, FAMILY].map((room_type_id) => ({ room_type_id })),
      }),
    changes: true,
  },
  {
    name: "an edit to a booking speed rule that is on: a new amount",
    after: (t) => edited(t, R.bsFaster, { action_value: 12 }),
  },
  {
    name: "an edit to a booking speed rule that is on: an amount past another rule's",
    after: (t) => edited(t, R.bsSurging, { action_value: 10 }),
  },
  {
    name: "an edit to a pickup count rule that is on: a new amount and the undo box",
    after: (t) => edited(t, R.pickup, { action_value: 9.5, undo_on_cancellation: false }),
  },
];

/**
 * The rule's version_ranks as save_rule writes them when an edit moves its
 * version on: the earlier versions that still have changes on the price,
 * and the version the edit replaces while it has any.
 */
function withVersionRanks(t: Tables, after: FakeRow): FakeRow {
  const stored = t.pricing_rules.find((r) => r.id === after.id);
  if (!stored || Number(stored.version) === Number(after.version)) return after;
  const open = new Set(
    (t.pickup_event ?? []).filter((e) => e.rule_id === after.id && e.retired_at == null).map((e) => Number(e.rule_version)),
  );
  const ranks: Record<string, unknown> = {};
  for (const [v, rank] of Object.entries((stored.version_ranks ?? {}) as Record<string, unknown>)) if (open.has(Number(v))) ranks[v] = rank;
  if (open.has(Number(stored.version))) {
    const c = ((stored.rule_condition as FakeRow[] | undefined)?.[0] ?? {}) as FakeRow;
    ranks[String(stored.version)] = {
      priority: stored.priority,
      action_type: stored.action_type,
      action_direction: stored.action_direction,
      action_value: stored.action_value,
      condition: {
        occupancy_operator: c.occupancy_operator ?? null,
        dta_operator: c.dta_operator ?? null,
        pickup_operator: c.pickup_operator ?? null,
        pickup_threshold: c.pickup_threshold ?? null,
        pickup_metric: c.pickup_metric ?? null,
        booking_speed_operator: c.booking_speed_operator ?? null,
        booking_speed_level: c.booking_speed_level ?? null,
      },
    };
  }
  return { ...after, version_ranks: Object.keys(ranks).length > 0 ? ranks : null };
}

/** The rule saved as Apply saves it: on, no Skip, no holds. */
function saveApply(t: Tables, after: FakeRow): Tables {
  const out = clone(t);
  out.pricing_rules = [...out.pricing_rules.filter((r) => r.id !== after.id), { ...withVersionRanks(t, after), is_active: true, skip_at: null }];
  out.rule_skip_hold = (out.rule_skip_hold ?? []).filter((h) => h.rule_id !== after.id);
  return out;
}

/**
 * The hotel with the rule not acting at all: absent when it is new, and off
 * otherwise (its changes on the price frozen, as switching it off leaves
 * them). What Skip must price exactly like on the nights it holds.
 */
function notActing(t: Tables, after: FakeRow): Tables {
  const out = clone(t);
  for (const r of out.pricing_rules) if (r.id === after.id) r.is_active = false;
  return out;
}

/** notActing for a stored rule, by id. */
function notActingById(t: Tables, id: string): Tables {
  return notActing(t, t.pricing_rules.find((r) => r.id === id)!);
}

const ids = (v: unknown) => (Array.isArray(v) ? v.map((x) => String((x as FakeRow).room_type_id)) : []);

/**
 * The rule saved as save_rule saves a Skip: on, skip_at, the marks on a
 * standard rule's rows, and the holds (rule_skip_hold) on the days held: a
 * booking speed or pickup rule's on every room type it changes and every
 * one with a change of it on the price, and any rule's on its booking speed
 * or pickup changes there.
 */
function saveSkip(t: Tables, after: FakeRow, plan: SkipPlan, at: string): Tables {
  const out = clone(t);
  out.pricing_rules = [...out.pricing_rules.filter((r) => r.id !== after.id), { ...withVersionRanks(t, after), is_active: true, skip_at: at }];
  const rows = out.ladder_rule_state;
  const find = (m: SkipMark) => rows.find((r) => r.rule_id === after.id && String(r.stay_date) === m.d && r.room_type_id === m.rt);
  for (const m of plan.marks) {
    const row = find(m);
    if (m.w === "held") {
      const held = {
        rule_id: after.id,
        rule_version: after.version,
        stay_date: m.d,
        room_type_id: m.rt,
        is_active: true,
        activated_at: at,
        deactivated_at: null,
        suppressed_at: null,
        last_evaluated_at: at,
        action_kind: after.action_type,
        action_direction: after.action_direction,
        action_value: after.action_value,
        skip_state: "held",
        skip_at: at,
      };
      if (row) Object.assign(row, held);
      else rows.push(held);
      continue;
    }
    if (row?.is_active) Object.assign(row, { skip_state: m.w, skip_at: at, rule_version: after.version });
  }
  const nights = new Set(plan.holdNights);
  const cells = new Set<string>();
  if (after.is_pickup_rule) {
    for (const d of nights) for (const rt of ids(after.rule_affected_room_type)) cells.add(`${d}|${rt}`);
    for (const l of rows) if (l.rule_id === after.id && l.is_active && nights.has(String(l.stay_date))) cells.add(`${l.stay_date}|${l.room_type_id}`);
  }
  for (const e of out.pickup_event ?? []) {
    if (e.rule_id === after.id && e.retired_at == null && nights.has(String(e.stay_date))) cells.add(`${e.stay_date}|${e.affected_room_type_id}`);
  }
  out.rule_skip_hold = [
    ...(out.rule_skip_hold ?? []).filter((h) => h.rule_id !== after.id),
    ...[...cells].map((c) => ({ rule_id: after.id, stay_date: c.slice(0, 10), room_type_id: c.slice(11), skip_at: at, was_true: null })),
  ];
  return out;
}

/** The popup's days at `at`, and the Skip saved on them, the way the route saves it. */
async function skipAt(
  evaluate: EvaluateFn,
  t: Tables,
  after: FakeRow,
  at: string,
): Promise<{ preview: PreviewResult; plan: SkipPlan; tables: Tables }> {
  vi.setSystemTime(new Date(at));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = fake(clone(t)).client as any;
  const stored = t.pricing_rules.find((r) => r.id === after.id);
  const input = { hotelId: H, after: after as EngineRuleRow, at, horizonDays: HORIZON };
  const preview = await previewRule(client, { ...input, before: (stored?.is_active ? stored : null) as EngineRuleRow | null }, evaluate);
  const plan = await skipPlanForRule(client, input, preview.affected, evaluate);
  return { preview, plan, tables: saveSkip(t, after, plan, at) };
}

let bookingSeq = 0;
/** `n` bookings made at `at` on a night and room type. */
function book(t: Tables, at: string, stayDate: string, roomTypeId: string, n = 1): void {
  for (let i = 0; i < n; i++) {
    bookingSeq++;
    t.reservations.push({
      id: uuid("e1000000", bookingSeq),
      hotel_id: H,
      external_reservation_id: `k${bookingSeq}:1`,
      stay_date: stayDate,
      room_type_id: roomTypeId,
      booking_date: at.slice(0, 10),
      booking_window_days: Math.max(0, Math.round((Date.parse(stayDate) - Date.parse(at.slice(0, 10))) / 86_400_000)),
      current_rate: 200,
      base_rate: 200,
      created_at: at,
    });
  }
}

/** The bookings on a night and room type that match `which`, cancelled (gone from the PMS). */
function cancel(t: Tables, stayDate: string, roomTypeId: string, which: (r: FakeRow) => boolean): void {
  t.reservations = t.reservations.filter((r) => !(String(r.stay_date) === stayDate && r.room_type_id === roomTypeId && which(r)));
}

const priceOf = (t: Tables, night: string, rt: string) => published(t).get(`${night}|${rt}`);

/** King rooms booked on a night. */
const kingBooked = (t: Tables, night: string) => t.reservations.filter((r) => String(r.stay_date) === night && r.room_type_id === KING).length;

/** The hotel a day on: priced at T10 and again the next morning, nothing new in between. */
async function nextDay(evaluate: EvaluateFn, t: Tables): Promise<Tables> {
  return realRun(evaluate, await realRun(evaluate, t, T10), D1_00);
}

async function realRun(evaluate: EvaluateFn, t: Tables, at: string): Promise<Tables> {
  const db = fake(clone(t));
  vi.setSystemTime(new Date(at));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await evaluate(db.client as any, H, at, HORIZON);
  return db.tables;
}

async function fullDry(evaluate: EvaluateFn, t: Tables, at: string, rule?: FakeRow) {
  const capture = dryRunCapture();
  vi.setSystemTime(new Date(at));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await evaluate(readOnlyClient(fake(clone(t)).client as any), H, at, HORIZON, {
    dryRun: { capture, ...(rule ? { rule } : {}) },
  });
  return capture.prices;
}

for (const engine of ENGINES) {
  describe(`the popup's days on the ${engine.name}`, () => {
    let settled: Tables;
    beforeEach(async () => {
      engine.reset();
      vi.setSystemTime(new Date(T10));
      settled ??= await settle(engine.evaluate);
    }, 120_000);

    it.each(CASES)("$name: the days shown are the days Apply changes", async (c) => {
      const t = clone(settled);
      c.setup?.(t);
      const after = c.after(t);

      // What a full "after" against a full "before" says.
      const truth = nightsDiffering(await fullDry(engine.evaluate, t, T10, after), await fullDry(engine.evaluate, t, T10));

      // The popup's answer, whole and in the three chunks the popup asks for.
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = fake(clone(t)).client as any;
      const stored = t.pricing_rules.find((r) => r.id === after.id);
      const input = {
        hotelId: H,
        after: after as EngineRuleRow,
        before: (stored?.is_active ? stored : null) as EngineRuleRow | null,
        at: T10,
        horizonDays: HORIZON,
      };
      const whole = await previewRule(client, input, engine.evaluate);
      const chunks = await Promise.all([
        previewRule(client, { ...input, to: addDays(TODAY, 9) }, engine.evaluate),
        previewRule(client, { ...input, from: addDays(TODAY, 10), to: addDays(TODAY, 24) }, engine.evaluate),
        previewRule(client, { ...input, from: addDays(TODAY, 25) }, engine.evaluate),
      ]);
      expect(whole.affected).toEqual(truth);
      expect(chunks.flatMap((x) => x.affected)).toEqual(truth);
      expect(whole.lastNight).toBe(addDays(TODAY, HORIZON - 1));
      // The nights the rule reaches: its scope, whole or added up over the chunks.
      expect(whole.reach).toBe(nightsInScope(after as EngineRuleRow, WINDOW, TODAY, T10, TZ).length);
      expect(chunks.reduce((n, x) => n + x.reach, 0)).toBe(whole.reach);
      // What the popup adds for a cut on low pickup with nothing to keep it near, and for nothing else.
      expect(whole.farOutCut).toEqual(c.farOutCut ?? null);
      expect(farOutCutOfRow(after as EngineRuleRow)).toEqual(c.farOutCut ?? null);
      if (c.farOutCut) expect(whole.reach).toBe(HORIZON);
      if (c.changes) expect(truth.length).toBeGreaterThan(0);
      for (const night of whole.affected) expect(whole.roomTypesChanged[night]).toBeGreaterThan(0);

      // Apply: the rule saved on, then the run the sync makes.
      const applied = published(await realRun(engine.evaluate, saveApply(t, after), T10));
      const without = published(await realRun(engine.evaluate, t, T10));
      expect(nightsDiffering(applied, without)).toEqual(whole.affected);
    }, 120_000);

    it.each(CASES)("$name: Skip holds the days shown, and every other day prices as Apply does", async (c) => {
      const t = clone(settled);
      c.setup?.(t);
      const after = c.after(t);
      const { preview, tables } = await skipAt(engine.evaluate, t, after, T10);
      const held = new Set(preview.affected);
      const heldMoved = (a: Tables, b: Tables) => nightsDiffering(published(a), published(b)).filter((d) => held.has(d));
      const otherMoved = (a: Tables, b: Tables) => nightsDiffering(published(a), published(b)).filter((d) => !held.has(d));
      const skipped = await realRun(engine.evaluate, tables, T11);
      const without = await realRun(engine.evaluate, notActing(t, after), T11);
      const applied = await realRun(engine.evaluate, saveApply(t, after), T11);
      // The days shown keep their prices, as if the rule were not there.
      expect(heldMoved(skipped, without)).toEqual([]);
      // Every other day is priced as Apply prices it.
      expect(otherMoved(skipped, applied)).toEqual([]);
      // And the run after that, with nothing new, the same.
      const again = await realRun(engine.evaluate, skipped, T20);
      expect(heldMoved(again, await realRun(engine.evaluate, without, T20))).toEqual([]);
      expect(otherMoved(again, await realRun(engine.evaluate, applied, T20))).toEqual([]);
    }, 120_000);

    it("Skip holds exactly the days shown on a standard rule, and lets each go only once the rule stops and starts being true there", async () => {
      // Occupancy of King over 35% (more than 3 of its 10 rooms), +8% on King.
      const after = ruleRow(NEW, { ...created, action_value: 8, cond: { occupancy_operator: "gt", occupancy_threshold: 0.35 }, affected: [KING], signals: [KING] });
      const { preview, plan, tables } = await skipAt(engine.evaluate, settled, after, T10);
      expect(preview.affected.length).toBeGreaterThan(1);
      // A mark on every day shown, and on no other.
      expect(plan.marks.every((m) => m.w === "held" && m.rt === KING)).toBe(true);
      expect(plan.marks.map((m) => m.d)).toEqual(preview.affected);
      let skip = await realRun(engine.evaluate, tables, T11);
      let none = await realRun(engine.evaluate, settled, T11);
      const heldRows = skip.ladder_rule_state.filter((r) => r.rule_id === NEW && r.is_active && r.skip_state === "held");
      expect(heldRows.map((r) => String(r.stay_date)).sort()).toEqual(preview.affected);
      for (const d of preview.affected) expect(priceOf(skip, d, KING)).toBe(priceOf(none, d, KING));

      const both = async (at: string, change: (x: Tables) => void) => {
        const a = clone(skip);
        const b = clone(none);
        change(a);
        change(b);
        skip = await realRun(engine.evaluate, a, at);
        none = await realRun(engine.evaluate, b, at);
      };
      const row = (night: string) => skip.ladder_rule_state.find((r) => r.rule_id === NEW && String(r.stay_date) === night && r.room_type_id === KING);
      const d = preview.affected[preview.affected.length - 1];
      const kingOn = (x: Tables) => kingBooked(x, d);
      expect(kingOn(skip)).toBeGreaterThan(3);

      // Still true, with one more booking: still held.
      await both(T20, (x) => book(x, T20, d, KING, 1));
      expect(priceOf(skip, d, KING)).toBe(priceOf(none, d, KING));
      expect(row(d)?.skip_state).toBe("held");
      // No longer true (bookings cancelled down to 3 of 10): no price moves, and the hold is over.
      await both(T30, (x) => {
        const keep = new Set(x.reservations.filter((r) => String(r.stay_date) === d && r.room_type_id === KING).slice(0, 3).map((r) => r.id));
        cancel(x, d, KING, (r) => !keep.has(r.id));
      });
      expect(kingOn(skip)).toBe(3);
      expect(priceOf(skip, d, KING)).toBe(priceOf(none, d, KING));
      expect(row(d)?.is_active).toBe(false);
      // True again: now it adjusts.
      await both(T40, (x) => book(x, T40, d, KING, 3));
      expect(priceOf(skip, d, KING)!).toBeGreaterThan(priceOf(none, d, KING)!);
      expect(row(d)).toMatchObject({ is_active: true, skip_state: null });
      // The other days shown are still held.
      for (const x of preview.affected.slice(0, -1)) {
        expect(priceOf(skip, x, KING)).toBe(priceOf(none, x, KING));
        expect(row(x)?.skip_state).toBe("held");
      }
      // A day not shown that becomes true after the Skip adjusts at once.
      const quiet = WINDOW.find((x) => x > addDays(TODAY, 5) && !preview.affected.includes(x) && kingBooked(skip, x) <= 3)!;
      await both(T50, (x) => book(x, T50, quiet, KING, 4 - kingBooked(x, quiet)));
      expect(priceOf(skip, quiet, KING)!).toBeGreaterThan(priceOf(none, quiet, KING)!);
    }, 120_000);

    it("Skip holds a pickup rule on exactly the days shown, and lets each go only once the rule stops and starts being true there", async () => {
      // More than 1 King room night booked today, +30% on King: the
      // strongest raise, so no other rule's change decides for it.
      const after = ruleRow(NEW, { ...created, created_at: D1_05, updated_at: D1_05, priority: 140, action_value: 30, cond: { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" }, affected: [KING], signals: [KING] });
      const base = await nextDay(engine.evaluate, settled);
      const [n1, n2, n3] = [addDays(D1, 20), addDays(D1, 24), addDays(D1, 28)];
      book(base, D1_01, n1, KING, 2);
      book(base, D1_01, n2, KING, 2);
      const { preview, tables } = await skipAt(engine.evaluate, base, after, D1_05);
      expect(preview.affected).toEqual([n1, n2]);
      // A hold on each day shown, on the room type it changes.
      expect(tables.rule_skip_hold.filter((h) => h.rule_id === NEW).map((h) => `${h.stay_date}|${h.room_type_id}`).sort()).toEqual([`${n1}|${KING}`, `${n2}|${KING}`]);
      let skip = await realRun(engine.evaluate, tables, D1_10);
      let none = await realRun(engine.evaluate, base, D1_10);
      const fires = (night: string) => skip.pickup_event.filter((e) => e.rule_id === NEW && String(e.stay_date) === night && e.retired_at == null);
      const hold = (night: string) => skip.rule_skip_hold.find((h) => h.rule_id === NEW && String(h.stay_date) === night);
      const both = async (at: string, change: (x: Tables) => void) => {
        const a = clone(skip);
        const b = clone(none);
        change(a);
        change(b);
        skip = await realRun(engine.evaluate, a, at);
        none = await realRun(engine.evaluate, b, at);
      };
      expect(fires(n1)).toEqual([]);
      expect(fires(n2)).toEqual([]);
      expect(hold(n1)?.was_true).toBe(true);
      for (const d of [n1, n2]) expect(priceOf(skip, d, KING)).toBe(priceOf(none, d, KING));

      // n1 stops being true (its bookings cancelled); n2 stays true with one more; n3, not shown, becomes true.
      await both(D1_20, (x) => {
        cancel(x, n1, KING, (r) => r.created_at === D1_01);
        book(x, D1_20, n2, KING, 1);
        book(x, D1_20, n3, KING, 2);
      });
      expect(fires(n1)).toEqual([]);
      expect(hold(n1)?.was_true).toBe(false);
      expect(fires(n2)).toEqual([]);
      expect(hold(n2)?.was_true).toBe(true);
      for (const d of [n1, n2]) expect(priceOf(skip, d, KING)).toBe(priceOf(none, d, KING));
      expect(fires(n3)).toHaveLength(1);
      // n1 is true again: the hold is over and the rule adjusts in that run.
      await both(D1_30, (x) => book(x, D1_30, n1, KING, 2));
      expect(hold(n1)).toBeUndefined();
      expect(fires(n1)).toHaveLength(1);
      expect(fires(n2)).toEqual([]);
      expect(priceOf(skip, n2, KING)).toBe(priceOf(none, n2, KING));
    }, 120_000);

    it("an edit to a pickup rule saved with Skip keeps its change on a held day until the rule stops and starts being true, then moves it to the new amount in that run", async () => {
      // More than 1 King room night today, +30%, applied: it raises n. Edited
      // to +20% with Skip: the +30% stays while held; once the rule is true
      // again after not being true, the +30% comes off and +20% goes on.
      const v1 = ruleRow(NEW, { ...created, created_at: D1_05, updated_at: D1_05, priority: 140, action_value: 30, cond: { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" }, affected: [KING], signals: [KING] });
      const base = await nextDay(engine.evaluate, settled);
      const n = addDays(D1, 21);
      book(base, D1_01, n, KING, 2);
      let t = await realRun(engine.evaluate, saveApply(base, v1), D1_05);
      const open = (x: Tables) => x.pickup_event.filter((e) => e.rule_id === NEW && String(e.stay_date) === n && e.retired_at == null);
      expect(open(t).map((e) => Number(e.action_value))).toEqual([30]);

      const v2 = edited(t, NEW, { action_value: 20 });
      const { preview, tables } = await skipAt(engine.evaluate, t, v2, D1_10);
      expect(preview.affected).toContain(n);
      t = await realRun(engine.evaluate, tables, D1_12);
      expect(open(t).map((e) => [Number(e.rule_version), Number(e.action_value)])).toEqual([[1, 30]]);
      // Not true (its bookings cancelled): the +30% stays.
      cancel(t, n, KING, (r) => r.created_at === D1_01);
      t = await realRun(engine.evaluate, t, D1_20);
      expect(open(t).map((e) => [Number(e.rule_version), Number(e.action_value)])).toEqual([[1, 30]]);
      // True again: the edited rule takes over there, in that run.
      book(t, D1_30, n, KING, 2);
      t = await realRun(engine.evaluate, t, D1_30);
      expect(open(t).map((e) => [Number(e.rule_version), Number(e.action_value)])).toEqual([[2, 20]]);
      const old = t.pickup_event.find((e) => e.rule_id === NEW && String(e.stay_date) === n && Number(e.rule_version) === 1)!;
      expect(old.retired_reason).toBe("rule_edited");
      expect(t.rule_skip_hold.filter((h) => h.rule_id === NEW && String(h.stay_date) === n)).toEqual([]);
    }, 120_000);

    it("a pickup rule and a booking speed rule created after bookings came in count those bookings, with Apply and with Skip", async () => {
      // Pickup: more than 2 King room nights today. Two were booked before
      // the rule existed; one more after it makes three, with Apply and with
      // Skip alike. Without the two, one more is not enough.
      const pickup = ruleRow(NEW, { ...created, created_at: D1_05, updated_at: D1_05, priority: 140, action_value: 30, cond: { pickup_operator: "gt", pickup_threshold: 2, pickup_window_days: 1, pickup_metric: "room_nights" }, affected: [KING], signals: [KING] });
      const base = await nextDay(engine.evaluate, settled);
      const m = addDays(D1, 22);
      const control = clone(base);
      book(base, D1_01, m, KING, 2);
      const { preview, tables: skipped } = await skipAt(engine.evaluate, base, pickup, D1_05);
      expect(preview.affected).not.toContain(m);
      const worlds = { apply: saveApply(base, pickup), skip: skipped, control: saveApply(control, pickup) };
      for (const [name, w] of Object.entries(worlds)) {
        book(w, D1_10, m, KING, 1);
        const run = await realRun(engine.evaluate, w, D1_10);
        const fire = run.pickup_event.filter((e) => e.rule_id === NEW && String(e.stay_date) === m && e.retired_at == null);
        if (name === "control") {
          expect({ name, fires: fire.length }).toEqual({ name, fires: 0 });
          continue;
        }
        expect({ name, fires: fire.length }).toEqual({ name, fires: 1 });
        // It counted from the start of the day, before the rule existed: all three.
        expect(Date.parse(String(fire[0].baseline_start_ts))).toBeLessThan(Date.parse(D1_05));
        expect(Number(fire[0].signal_booked_units_end) - Number(fire[0].signal_booked_units_start)).toBe(3);
      }

      // Booking speed: at least Faster over the last week, +30%. A night it
      // was not true on when it was created gets eight bookings after it:
      // it counts them with the ones made before it, the week's whole count.
      const bs = ruleRow(NEW, { ...created, priority: 140, action_value: 30, cond: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 3 } });
      const b = await skipAt(engine.evaluate, settled, bs, T10);
      const weekAgo = Date.parse(`${addDays(TODAY, -6)}T00:00:00Z`);
      const madeThisWeek = (t: Tables, night: string) =>
        t.reservations.filter((r) => String(r.stay_date) === night && Date.parse(String(r.created_at)) >= weekAgo).length;
      // The strongest raise (+30%), so no other rule's change is one it counts from.
      const n = WINDOW.find((x) => x > addDays(TODAY, 10) && !b.preview.affected.includes(x) && madeThisWeek(settled, x) >= 2)!;
      expect(n).toBeDefined();
      for (const [name, w] of Object.entries({ apply: saveApply(settled, bs), skip: b.tables })) {
        for (let i = 0; i < 8; i++) book(w, T20, n, RT[i % RT.length], 1);
        const run = await realRun(engine.evaluate, w, T20);
        const fire = run.pickup_event.filter((e) => e.rule_id === NEW && String(e.stay_date) === n && e.retired_at == null);
        expect({ name, fired: fire.length > 0 }).toEqual({ name, fired: true });
        expect({ name, since: fire[0].window_since ?? null }).toEqual({ name, since: null });
        expect(Number(fire[0].window_bookings_at_fire)).toBeGreaterThan(8);
      }
    }, 120_000);

    it("an edit saved with Skip leaves each change it would move where it is, and Apply later judges them against the edited rule", async () => {
      const after = edited(settled, R.busy, { action_value: 20, rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.75 }] });
      const { preview, plan, tables } = await skipAt(engine.evaluate, settled, after, T10);
      // Where the edited rule no longer holds, the change stays (kept); where it does, it stays at its old amount (carried).
      // Only on the days shown (some of those the rule as stored would have changed now, and the edited one leaves alone).
      expect(plan.marks.some((m) => m.w === "kept")).toBe(true);
      expect(plan.marks.every((m) => preview.affected.includes(m.d))).toBe(true);
      const skipped = await realRun(engine.evaluate, tables, T11);
      const marked = skipped.ladder_rule_state.filter((r) => r.rule_id === R.busy && r.is_active && r.skip_state);
      expect(marked.length).toBe(plan.marks.length);
      expect(marked.every((r) => Number(r.action_value) === 15)).toBe(true);

      // Apply later (the Skip cleared): the popup's days are the prices that move.
      const reapplied: FakeRow = { ...after, skip_at: null };
      vi.setSystemTime(new Date(T20));
      const storedNow = skipped.pricing_rules.find((r) => r.id === R.busy)!;
      const again = await previewRule(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fake(clone(skipped)).client as any,
        { hotelId: H, after: reapplied as EngineRuleRow, before: storedNow as EngineRuleRow, at: T20, horizonDays: HORIZON },
        engine.evaluate,
      );
      const applied = published(await realRun(engine.evaluate, saveApply(skipped, reapplied), T20));
      const without = published(await realRun(engine.evaluate, skipped, T20));
      expect(nightsDiffering(applied, without)).toEqual(again.affected);
      expect(again.affected.length).toBeGreaterThan(0);
    }, 120_000);

    it("an edit saved with Skip carries each change at its old amount once the rule stops holding, and switching it off and on with Apply shows and moves them", async () => {
      // "Busy nights" from +15% to +20%, same bar, saved with Skip: its
      // changes stay at +15% (carried). Off and on again with Apply, the
      // popup shows those days and Apply moves them to +20%.
      const after = edited(settled, R.busy, { action_value: 20 });
      const { preview, plan, tables } = await skipAt(engine.evaluate, settled, after, T10);
      const carriedMarks = plan.marks.filter((m) => m.w === "carried");
      expect(carriedMarks.length).toBeGreaterThan(0);
      // The rest: nights the rule was about to switch on at +20%, held off.
      expect(plan.marks.every((m) => m.w === "carried" || m.w === "held")).toBe(true);
      const skipped = await realRun(engine.evaluate, tables, T11);
      const carried = skipped.ladder_rule_state.filter((r) => r.rule_id === R.busy && r.is_active && r.skip_state === "carried");
      expect(carried.length).toBe(carriedMarks.length);
      expect(carried.every((r) => Number(r.action_value) === 15)).toBe(true);
      const carriedNights = [...new Set(carried.map((r) => String(r.stay_date)))].sort();
      expect(carriedNights.every((d) => preview.affected.includes(d))).toBe(true);

      // One of them stops holding (bookings cancelled): the change stays, now kept.
      const d = carriedNights[carriedNights.length - 1];
      const t = clone(skipped);
      cancel(t, d, KING, () => true);
      cancel(t, d, QUEEN, () => true);
      const later = await realRun(engine.evaluate, t, T20);
      const row = later.ladder_rule_state.find((r) => r.rule_id === R.busy && String(r.stay_date) === d && r.room_type_id === SUITE)!;
      expect(row).toMatchObject({ is_active: true, skip_state: "kept" });
      expect(Number(row.action_value)).toBe(15);

      const off = clone(skipped);
      off.pricing_rules.find((r) => r.id === R.busy)!.is_active = false;
      const stored = off.pricing_rules.find((r) => r.id === R.busy)!;
      const onAgain = { ...stored, is_active: true, skip_at: null };
      vi.setSystemTime(new Date(T20));
      const shown = await previewRule(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fake(clone(off)).client as any,
        { hotelId: H, after: onAgain as unknown as EngineRuleRow, before: null, at: T20, horizonDays: HORIZON },
        engine.evaluate,
      );
      for (const n of carriedNights) expect(shown.affected).toContain(n);
      const on = await realRun(engine.evaluate, saveApply(off, onAgain), T20);
      expect(nightsDiffering(published(on), published(await realRun(engine.evaluate, off, T20)))).toEqual(shown.affected);
      const moved = on.ladder_rule_state.filter((r) => r.rule_id === R.busy && r.is_active && carriedNights.includes(String(r.stay_date)));
      expect(moved.length).toBeGreaterThan(0);
      expect(moved.every((r) => Number(r.action_value) === 20 && (r.skip_state ?? null) === null)).toBe(true);
    }, 120_000);

    // The undo box keeps a change that is on the price through cancellations.
    // A day Skip holds has no change of the rule on it (held) or one the owner
    // chose to leave as it was (carried), so the box keeps nothing there: the
    // hold ends on whether the rule is really true, ticked or not.
    it("with the undo box unticked, Skip lets a held day go once the rule stops and starts being true there", async () => {
      const after = ruleRow(NEW, { ...created, action_value: 8, undo_on_cancellation: false, cond: { occupancy_operator: "gt", occupancy_threshold: 0.35 }, affected: [KING], signals: [KING] });
      const { preview, plan, tables } = await skipAt(engine.evaluate, settled, after, T10);
      expect(preview.affected.length).toBeGreaterThan(1);
      expect(plan.marks.every((m) => m.w === "held")).toBe(true);
      let skip = await realRun(engine.evaluate, tables, T11);
      let none = await realRun(engine.evaluate, settled, T11);
      const both = async (at: string, change: (x: Tables) => void) => {
        const a = clone(skip);
        const b = clone(none);
        change(a);
        change(b);
        skip = await realRun(engine.evaluate, a, at);
        none = await realRun(engine.evaluate, b, at);
      };
      const d = preview.affected[preview.affected.length - 1];
      const row = () => skip.ladder_rule_state.find((r) => r.rule_id === NEW && String(r.stay_date) === d && r.room_type_id === KING);
      expect(row()).toMatchObject({ is_active: true, skip_state: "held" });
      // Cancelled down to 3 of 10: no longer more than 35%. No price moves, and the hold is over.
      await both(T30, (x) => {
        const keep = new Set(x.reservations.filter((r) => String(r.stay_date) === d && r.room_type_id === KING).slice(0, 3).map((r) => r.id));
        cancel(x, d, KING, (r) => !keep.has(r.id));
      });
      expect(kingBooked(skip, d)).toBe(3);
      expect(priceOf(skip, d, KING)).toBe(priceOf(none, d, KING));
      expect(row()?.is_active).toBe(false);
      // True again: now it adjusts, and the box keeps that change from here on.
      await both(T40, (x) => book(x, T40, d, KING, 3));
      expect(priceOf(skip, d, KING)!).toBeGreaterThan(priceOf(none, d, KING)!);
      expect(row()).toMatchObject({ is_active: true, skip_state: null });
      // Cancelled down again: that change stays (the other rules' own may not).
      await both(T50, (x) => {
        const keep = new Set(x.reservations.filter((r) => String(r.stay_date) === d && r.room_type_id === KING).slice(0, 3).map((r) => r.id));
        cancel(x, d, KING, (r) => !keep.has(r.id));
      });
      expect(row()).toMatchObject({ is_active: true, skip_state: null });
      expect(priceOf(skip, d, KING)!).toBeGreaterThan(priceOf(none, d, KING)!);
    }, 120_000);

    it("with the undo box unticked, an edit saved with Skip moves a carried change to the new amount once the rule stops and starts being true there", async () => {
      // "Busy nights" unticked, from +15% to +20%, saved with Skip.
      const t0 = clone(settled);
      t0.pricing_rules.find((r) => r.id === R.busy)!.undo_on_cancellation = false;
      const after = edited(t0, R.busy, { action_value: 20 });
      const { plan, tables } = await skipAt(engine.evaluate, t0, after, T10);
      expect(plan.marks.some((m) => m.w === "carried")).toBe(true);
      let t = await realRun(engine.evaluate, tables, T11);
      const carried = t.ladder_rule_state.filter((r) => r.rule_id === R.busy && r.is_active && r.skip_state === "carried");
      const d = String(carried[carried.length - 1].stay_date);
      const onNight = (x: Tables) => x.ladder_rule_state.filter((r) => r.rule_id === R.busy && String(r.stay_date) === d && r.is_active);
      expect(onNight(t).every((r) => r.skip_state === "carried" && Number(r.action_value) === 15)).toBe(true);
      // Every booking on the night cancelled: the rule stops being true, the change stays at +15% (kept).
      t = clone(t);
      t.reservations = t.reservations.filter((r) => String(r.stay_date) !== d);
      t = await realRun(engine.evaluate, t, T20);
      expect(onNight(t).length).toBeGreaterThan(0);
      expect(onNight(t).every((r) => r.skip_state === "kept" && Number(r.action_value) === 15)).toBe(true);
      // Booked up again: true again, and the change moves to +20%.
      t = clone(t);
      for (const rt of [KING, QUEEN, SUITE, FAMILY]) book(t, T30, d, rt, 12);
      const before = priceOf(t, d, KING)!;
      t = await realRun(engine.evaluate, t, T30);
      expect(onNight(t).length).toBeGreaterThan(0);
      expect(onNight(t).every((r) => (r.skip_state ?? null) === null && Number(r.action_value) === 20)).toBe(true);
      expect(priceOf(t, d, KING)!).toBeGreaterThan(before);
    }, 120_000);

    it("with the undo box unticked, a change on a room type taken off the rule and carried by Skip is kept once the rule stops being true, and comes off once it is true again", async () => {
      // "Busy nights" unticked, Suite taken off it, saved with Skip: the
      // Suite changes where the rule is true now are carried.
      const t0 = clone(settled);
      t0.pricing_rules.find((r) => r.id === R.busy)!.undo_on_cancellation = false;
      const after = edited(t0, R.busy, { rule_affected_room_type: [KING, QUEEN, FAMILY].map((room_type_id) => ({ room_type_id })) });
      const { plan, tables } = await skipAt(engine.evaluate, t0, after, T10);
      expect(plan.marks.some((m) => m.w === "carried" && m.rt === SUITE)).toBe(true);
      let t = await realRun(engine.evaluate, tables, T11);
      const suiteRow = (x: Tables, night: string) => x.ladder_rule_state.find((r) => r.rule_id === R.busy && String(r.stay_date) === night && r.room_type_id === SUITE);
      const carried = t.ladder_rule_state.filter((r) => r.rule_id === R.busy && r.room_type_id === SUITE && r.is_active && r.skip_state === "carried");
      const d = String(carried[carried.length - 1].stay_date);
      // Every booking on the night cancelled: the rule stops being true, the change stays (kept).
      t = clone(t);
      t.reservations = t.reservations.filter((r) => String(r.stay_date) !== d);
      t = await realRun(engine.evaluate, t, T20);
      expect(suiteRow(t, d)).toMatchObject({ is_active: true, skip_state: "kept" });
      // Booked up again: true again, and the change comes off Suite.
      t = clone(t);
      for (const rt of [KING, QUEEN, SUITE, FAMILY]) book(t, T30, d, rt, 12);
      t = await realRun(engine.evaluate, t, T30);
      expect(suiteRow(t, d)?.is_active).toBe(false);
    }, 120_000);

    it("an edit to a rule that is off moves no price until it is switched on", async () => {
      const t = clone(settled);
      const paused = t.pricing_rules.find((r) => r.id === R.pausedBs)!;
      Object.assign(paused, { version: 2, action_value: 30 });
      const run = await realRun(engine.evaluate, t, T11);
      const without = await realRun(engine.evaluate, settled, T11);
      expect(nightsDiffering(published(run), published(without))).toEqual([]);
      // Its changes are still on the price, frozen.
      expect(run.pickup_event.filter((e) => e.rule_id === R.pausedBs && e.retired_at == null).length).toBeGreaterThan(0);
    }, 120_000);
  });
}

describe("Skip after an edit to a booking speed rule that is on", () => {
  // A change the Skip leaves on the price keeps covering the weaker rules it
  // covered: it ranks as it was made, not as the edited rule. Lowering
  // Surging's amount (or making it fixed, changing its speed, or making it a
  // standard rule) must not let Much Faster or Faster raise again, on the
  // days held, on bookings Surging's change already covered; every other day
  // is priced as Apply prices it. Seeds 5, 31 and 43 are hotels where
  // Surging's changes are on the price over a weaker raise.
  const EDITS: { name: string; id: string; patch: Record<string, unknown> }[] = [
    { name: "Surging from +25% to +10%", id: R.bsSurging, patch: { action_value: 10 } },
    { name: "Surging from +25% to a fixed +$5", id: R.bsSurging, patch: { action_type: "fixed", action_value: 5 } },
    {
      name: "Surging's speed to at least Faster, still +25%",
      id: R.bsSurging,
      patch: { rule_condition: [{ booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 }] },
    },
    { name: "Much Faster from +25% to +8%", id: R.bsMuchFaster, patch: { action_value: 8 } },
    {
      name: "Surging made a standard rule (occupancy over 50%), +10%",
      id: R.bsSurging,
      patch: { is_pickup_rule: false, action_value: 10, rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.5 }] },
    },
  ];
  for (const engine of ENGINES) {
    it.each([5, 31, 43])(`hotel seed %i on the ${engine.name}: the days held keep their prices, the rest price as Apply does`, async (seedNo) => {
      engine.reset();
      vi.setSystemTime(new Date(T10));
      const t = await settle(engine.evaluate, seedNo);
      const without = await realRun(engine.evaluate, notActingById(t, R.bsSurging), T11);
      const withoutMf = await realRun(engine.evaluate, notActingById(t, R.bsMuchFaster), T11);
      const moved: Record<string, string[]> = {};
      for (const e of EDITS) {
        const after = edited(t, e.id, e.patch);
        const { preview, tables } = await skipAt(engine.evaluate, t, after, T10);
        const held = new Set(preview.affected);
        const skipped = published(await realRun(engine.evaluate, tables, T11));
        const applied = published(await realRun(engine.evaluate, saveApply(t, after), T11));
        const base = published(e.id === R.bsSurging ? without : withoutMf);
        moved[e.name] = [
          ...nightsDiffering(skipped, base).filter((d) => held.has(d)),
          ...nightsDiffering(skipped, applied).filter((d) => !held.has(d)),
        ].sort();
      }
      // An edit to a rule that is off moves no price either: its changes
      // stay on, frozen, and cover what they covered.
      const paused = notActingById(t, R.bsSurging);
      const offEdit = clone(paused);
      const afterOff = { ...withVersionRanks(paused, edited(paused, R.bsSurging, { action_value: 10 })), is_active: false };
      offEdit.pricing_rules = [...offEdit.pricing_rules.filter((r) => r.id !== R.bsSurging), afterOff];
      moved["Surging edited to +10% while off"] = nightsDiffering(published(await realRun(engine.evaluate, offEdit, T11)), published(without));
      expect(moved).toEqual(Object.fromEntries([...EDITS.map((e) => e.name), "Surging edited to +10% while off"].map((n) => [n, []])));
    }, 480_000);
  }
});

describe("the popup's days after an edit to the amount alone, on hotels with rules drawn at random", () => {
  // "Before" runs only where the edited rule has a part when the edit moves
  // the rule past no other rule (see previewRule): the days are still the
  // days a full "after" against a full "before" gives, and what Apply does.
  const engine = ENGINES[0];
  it.each([3, 19, 31])("hotel seed %i", async (seedNo) => {
    engine.reset();
    vi.setSystemTime(new Date(T10));
    const t = await settle(engine.evaluate, seedNo);
    const r = rng(seedNo * 13 + 5);
    const events = t.pricing_rules.filter((x) => x.is_active && x.is_pickup_rule);
    const seen: Record<string, number> = {};
    for (const stored of events) {
      const after = edited(t, String(stored.id), { action_value: Math.round((Number(stored.action_value) + (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 4))) * 10) / 10 });
      const truth = nightsDiffering(await fullDry(engine.evaluate, t, T10, after), await fullDry(engine.evaluate, t, T10));
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = fake(clone(t)).client as any;
      const input = { hotelId: H, after: after as EngineRuleRow, before: stored as EngineRuleRow, at: T10, horizonDays: HORIZON };
      const whole = await previewRule(client, input, engine.evaluate);
      const parts = [
        await previewRule(client, { ...input, to: addDays(TODAY, 14) }, engine.evaluate),
        await previewRule(client, { ...input, from: addDays(TODAY, 15) }, engine.evaluate),
      ];
      const label = `${stored.id} ${stored.action_value} to ${after.action_value}`;
      expect({ label, days: whole.affected }).toEqual({ label, days: truth });
      expect({ label, days: parts.flatMap((p) => p.affected) }).toEqual({ label, days: truth });
      const applied = published(await realRun(engine.evaluate, saveApply(t, after), T10));
      const without = published(await realRun(engine.evaluate, t, T10));
      expect({ label, days: nightsDiffering(applied, without) }).toEqual({ label, days: truth });
      seen[label] = whole.nightsChecked;
    }
    // The shorter way was taken on at least one edit (fewer nights run than both ways over the window).
    expect(Object.values(seen).some((n) => n < 2 * HORIZON)).toBe(true);
  }, 240_000);
});

describe("which nights the preview runs", () => {
  it("runs the rule as stored only where the saved one has a part when only its amount moves, and past no other rule", async () => {
    const { countsTheSameWay, keepsItsPlace } = await import("@/lib/rule-preview");
    const cond = { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 3 };
    const stored = ruleRow(NEW, { is_pickup_rule: true, action_value: 10, cond }) as EngineRuleRow;
    const same = (patch: Record<string, unknown>) => countsTheSameWay(stored, { ...stored, version: 2, ...patch } as EngineRuleRow);
    expect(same({ action_value: 12 })).toBe(true);
    expect(same({ action_value: 12, undo_on_cancellation: false })).toBe(true);
    expect(same({ rule_condition: [{ ...cond, booking_speed_window_days: 30 }] })).toBe(false);
    expect(same({ rule_affected_room_type: [{ room_type_id: KING }] })).toBe(false);
    expect(same({ action_direction: "decrease" })).toBe(false);
    expect(same({ dow_mask: 96 })).toBe(false);
    expect(countsTheSameWay({ ...stored, skip_at: T10 }, { ...stored, version: 2, action_value: 12 } as EngineRuleRow)).toBe(false);
    const rank = (value: number, type = "percent", priority = 100) => ({
      id: "x",
      version: 1,
      priority,
      condition: { booking_speed_operator: "at_least" as const, booking_speed_level: "faster" },
      action_type: type as "percent" | "fixed",
      action_direction: "increase" as const,
      action_value: value,
      created_at: "2026-01-01T00:00:00Z",
    });
    // 10% to 12% past a rule at 8% or 25%: the same place. Past one at 11%: not.
    expect(keepsItsPlace(rank(8), rank(10), rank(12))).toBe(true);
    expect(keepsItsPlace(rank(25), rank(10), rank(12))).toBe(true);
    expect(keepsItsPlace(rank(11), rank(10), rank(12))).toBe(false);
    // Level with it before, where its priority put the other first; ahead of it after: moved, so no.
    expect(keepsItsPlace(rank(10, "percent", 150), rank(10), rank(12))).toBe(false);
    // Level before with the rule first on priority, and first again after: the same place.
    expect(keepsItsPlace(rank(10, "percent", 50), rank(10), rank(12))).toBe(true);
    // Near it (a rounding tie on a small price), or a fixed amount against a percent: no.
    expect(keepsItsPlace(rank(12.5), rank(10), rank(12))).toBe(false);
    expect(keepsItsPlace(rank(8, "fixed"), rank(10), rank(12))).toBe(false);
  });


  it("reads every night the rule has a change on, past the rows one read returns", async () => {
    const { fakeSupabase } = await import("@/lib/engine/fake-supabase.test");
    const { nightsWithState } = await import("@/lib/rule-preview");
    const RULE = uuid("d2000000", 1);
    const nights = Array.from({ length: 300 }, (_, i) => addDays(TODAY, i));
    const roomTypes = Array.from({ length: 5 }, (_, i) => uuid("a2000000", i + 1));
    // 1,500 ladder rows and 1,200 fires, more than PostgREST's 1,000 a read.
    const ladder = nights.flatMap((d) => roomTypes.map((rt) => ({ rule_id: RULE, stay_date: d, room_type_id: rt, is_active: true })));
    const fires = nights.flatMap((d, i) =>
      roomTypes.slice(0, 4).map((rt, k) => ({ id: uuid("e2000000", i * 10 + k), hotel_id: H, rule_id: RULE, stay_date: d, affected_room_type_id: rt, retired_at: null })),
    );
    const last = nights[nights.length - 1];
    const onlyLadder = fakeSupabase({ ladder_rule_state: ladder, pickup_event: [] }, { maxRows: 1000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await nightsWithState(onlyLadder.client as any, H, RULE, TODAY, last)).toEqual(nights);
    const onlyFires = fakeSupabase({ ladder_rule_state: [], pickup_event: fires }, { maxRows: 1000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await nightsWithState(onlyFires.client as any, H, RULE, TODAY, last)).toEqual(nights);
  });

  it("drops nights out of the rule's scope or its days-before-arrival bar, but never one with a change of it on", async () => {
    const { nightsInScope } = await import("@/lib/rule-preview");
    const row = ruleRow(NEW, { cond: { dta_operator: "lt", dta_threshold_days: 5 }, dow_mask: 1 | 2 | 4 | 8 | 16 }) as EngineRuleRow;
    const nights = nightsInScope(row, WINDOW, TODAY, T10, "America/New_York");
    // Weekdays only (Monday to Friday), fewer than 5 days out.
    expect(nights).toEqual(WINDOW.slice(0, 5).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())));
    expect(RT.length).toBe(4);
  });
});

describe("the popup's days on other hotels, with rules drawn at random", () => {
  // Two more seeded hotels and random rules of each kind: whole and in
  // parts, the days shown are the days a full "after" against a full
  // "before" gives, and the days Apply changes.
  const engine = ENGINES[0];
  const random = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const LEVELS = ["much_slower", "slower", "faster", "much_faster", "surging"];
  const drawRule = (r: () => number, i: number): FakeRow => {
    const kind = i % 3;
    const up = r() < 0.6;
    const base = { ...created, action_type: r() < 0.7 ? "percent" : "fixed", action_direction: up ? "increase" : "decrease", action_value: 3 + Math.floor(r() * 20) };
    if (kind === 0) {
      return ruleRow(NEW, { ...base, cond: { occupancy_operator: up ? "gt" : "lt", occupancy_threshold: Math.round((0.2 + r() * 0.6) * 100) / 100, ...(r() < 0.5 ? { dta_operator: "lt", dta_threshold_days: 5 + Math.floor(r() * 30) } : {}) } });
    }
    if (kind === 1) {
      const level = LEVELS[Math.floor(r() * LEVELS.length)];
      const faster = ["faster", "much_faster", "surging"].includes(level);
      return ruleRow(NEW, { ...base, action_direction: faster ? "increase" : "decrease", priority: 100 + Math.floor(r() * 40), cond: { booking_speed_operator: faster ? "at_least" : "at_most", booking_speed_level: level, booking_speed_window_days: [1, 7, 30][Math.floor(r() * 3)], booking_speed_cooldown_days: [1, 2, 3, 7][Math.floor(r() * 4)] } });
    }
    return ruleRow(NEW, { ...base, priority: 100 + Math.floor(r() * 40), cond: { pickup_operator: "gt", pickup_threshold: Math.floor(r() * 3), pickup_window_days: [1, 3, 7][Math.floor(r() * 3)], pickup_metric: "room_nights" }, affected: r() < 0.5 ? [KING, QUEEN] : RT });
  };

  it.each([3, 19])("hotel seed %i", async (seedNo) => {
    engine.reset();
    vi.setSystemTime(new Date(T10));
    const t = await settle(engine.evaluate, seedNo);
    const r = random(seedNo * 7 + 1);
    for (let i = 0; i < 3; i++) {
      const after = drawRule(r, i);
      const truth = nightsDiffering(await fullDry(engine.evaluate, t, T10, after), await fullDry(engine.evaluate, t, T10));
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = fake(clone(t)).client as any;
      const input = { hotelId: H, after: after as EngineRuleRow, at: T10, horizonDays: HORIZON };
      const whole = await previewRule(client, input, engine.evaluate);
      const parts = [
        await previewRule(client, { ...input, to: addDays(TODAY, 14) }, engine.evaluate),
        await previewRule(client, { ...input, from: addDays(TODAY, 15) }, engine.evaluate),
      ];
      expect({ rule: after.rule_condition, days: whole.affected }).toEqual({ rule: after.rule_condition, days: truth });
      expect(parts.flatMap((p) => p.affected)).toEqual(truth);
      const applied = published(await realRun(engine.evaluate, saveApply(t, after), T10));
      const without = published(await realRun(engine.evaluate, t, T10));
      expect(nightsDiffering(applied, without)).toEqual(truth);
    }
  }, 120_000);
});
