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
 *   - Skip (the rule saved on with save_rule's marks and skip_at, then a
 *     real run) changes no price at all, and afterwards the rule acts on
 *     what changes (new bookings), not on what it matched at the Skip.
 *
 * Saving is simulated on the in-memory database the way save_rule writes it
 * (rule-activation-sql.test.ts runs save_rule itself in Postgres).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { dryRunCapture } from "@/lib/engine/evaluate";
import {
  previewRule,
  readOnlyClient,
  skipMarksForRule,
  type EngineRuleRow,
  type EvaluateFn,
  type SkipMark,
} from "@/lib/rule-preview";
import {
  ENGINES,
  FAMILY,
  H,
  HORIZON,
  KING,
  QUEEN,
  R,
  RT,
  T10,
  TODAY,
  churn,
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
const WINDOW = Array.from({ length: HORIZON }, (_, i) => addDays(TODAY, i));

type Case = {
  name: string;
  /** The rule as it will be after Apply. */
  after: (t: Tables) => FakeRow;
  /** Extra state before the change. */
  setup?: (t: Tables) => void;
  /** At least one night changes. */
  changes?: boolean;
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

/** The rule saved as Apply saves it: on, no Skip. */
function saveApply(t: Tables, after: FakeRow): Tables {
  const out = clone(t);
  out.pricing_rules = [...out.pricing_rules.filter((r) => r.id !== after.id), { ...withVersionRanks(t, after), is_active: true, skip_at: null }];
  return out;
}

/**
 * The hotel with the rule not acting at all: absent when it is new, and off
 * otherwise (its changes on the price frozen, as switching it off leaves
 * them). What Skip must price exactly like: the rule on, doing nothing to
 * what it matches now.
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

/** The rule saved as save_rule saves a Skip: on, skip_at, and the marks on its ladder rows. */
function saveSkip(t: Tables, after: FakeRow, marks: SkipMark[], at: string): Tables {
  const out = clone(t);
  out.pricing_rules = [...out.pricing_rules.filter((r) => r.id !== after.id), { ...withVersionRanks(t, after), is_active: true, skip_at: at }];
  const rows = out.ladder_rule_state;
  const find = (m: SkipMark) => rows.find((r) => r.rule_id === after.id && String(r.stay_date) === m.d && r.room_type_id === m.rt);
  for (const m of marks) {
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
    if (!row?.is_active) continue;
    if (m.w === "kept") Object.assign(row, { skip_state: "kept", skip_at: at, rule_version: after.version });
    if (m.w === "version") Object.assign(row, { rule_version: after.version, skip_state: null, skip_at: null });
    if (m.w === "restamp")
      Object.assign(row, {
        rule_version: after.version,
        action_kind: after.action_type,
        action_direction: after.action_direction,
        action_value: after.action_value,
        skip_state: null,
        skip_at: null,
      });
    if (m.w === "off") Object.assign(row, { is_active: false, deactivated_at: at, suppressed_at: null, skip_state: null, skip_at: null });
  }
  return out;
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
    });

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
      if (c.changes) expect(truth.length).toBeGreaterThan(0);
      for (const night of whole.affected) expect(whole.roomTypesChanged[night]).toBeGreaterThan(0);

      // Apply: the rule saved on, then the run the sync makes.
      const applied = published(await realRun(engine.evaluate, saveApply(t, after), T10));
      const without = published(await realRun(engine.evaluate, t, T10));
      expect(nightsDiffering(applied, without)).toEqual(whole.affected);
    });

    it.each(CASES)("$name: Skip prices as if the rule did nothing to what it matches now", async (c) => {
      const t = clone(settled);
      c.setup?.(t);
      const after = c.after(t);
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = fake(clone(t)).client as any;
      const marks = await skipMarksForRule(client, { hotelId: H, after: after as EngineRuleRow, at: T10, horizonDays: HORIZON }, engine.evaluate);
      const skipped = await realRun(engine.evaluate, saveSkip(t, after, marks, T10), T11);
      const without = await realRun(engine.evaluate, notActing(t, after), T11);
      expect(nightsDiffering(published(skipped), published(without))).toEqual([]);
      // And the run after that, with nothing new, still none.
      const again = await realRun(engine.evaluate, skipped, T20);
      const againWithout = await realRun(engine.evaluate, without, T20);
      expect(nightsDiffering(published(again), published(againWithout))).toEqual([]);
    });

    it("after a Skip, a standard rule acts on a night that becomes true, and leaves the ones it matched alone", async () => {
      const after = ruleRow(NEW, { ...created, action_value: 8, cond: { occupancy_operator: "gt", occupancy_threshold: 0.35 }, affected: [KING] });
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const marks = await skipMarksForRule(fake(clone(settled)).client as any, { hotelId: H, after: after as EngineRuleRow, at: T10, horizonDays: HORIZON }, engine.evaluate);
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.every((m) => m.w === "held")).toBe(true);
      const skipped = await realRun(engine.evaluate, saveSkip(settled, after, marks, T10), T11);
      const held = skipped.ladder_rule_state.filter((r) => r.rule_id === NEW && r.is_active && r.skip_state === "held");
      expect(held.length).toBe(marks.length);

      // A night it did not match at the Skip fills up past its bar.
      const heldNights = new Set(marks.map((m) => m.d));
      const quiet = WINDOW.find((d) => !heldNights.has(d) && d > addDays(TODAY, 20))!;
      const before = published(skipped);
      const t = clone(skipped);
      churn(t, T20, 5, 40, [quiet]);
      const later = await realRun(engine.evaluate, t, T20);
      const changed = nightsDiffering(published(later), before);
      expect(changed).toContain(quiet);
      // The nights it matched at the Skip keep their prices.
      for (const d of heldNights) expect(changed).not.toContain(d);
      const row = later.ladder_rule_state.find((r) => r.rule_id === NEW && r.stay_date === quiet && r.room_type_id === KING)!;
      expect(row.is_active).toBe(true);
      expect(row.skip_state ?? null).toBeNull();
    });

    it("after a Skip, a pickup count rule counts only the bookings made since", async () => {
      // The strongest raise on the night, so no other rule's change moves where it counts from.
      const after = ruleRow(NEW, { ...created, priority: 140, action_value: 30, cond: { pickup_operator: "gt", pickup_threshold: 2, pickup_window_days: 1, pickup_metric: "room_nights" }, affected: [KING], signals: [KING] });
      const skipped = await realRun(engine.evaluate, saveSkip(settled, after, [], T10), T11);
      const night = addDays(TODAY, 30);
      const booked = (t: Tables, at: string, n: number) => {
        for (let i = 0; i < n; i++) {
          t.reservations.push({ id: uuid("e0000000", Date.parse(at) / 1000 + i), hotel_id: H, external_reservation_id: `s${at}:${i}`, stay_date: night, room_type_id: KING, booking_date: TODAY, booking_window_days: 30, current_rate: 200, base_rate: 200, created_at: at });
        }
      };
      // Two since the Skip: not more than two.
      const t1 = clone(skipped);
      booked(t1, T20, 2);
      const r1 = await realRun(engine.evaluate, t1, T20);
      expect(r1.pickup_event.filter((e) => e.rule_id === NEW)).toEqual([]);
      // A third: it adjusts.
      booked(r1, T30, 1);
      const r2 = await realRun(engine.evaluate, r1, T30);
      expect(r2.pickup_event.filter((e) => e.rule_id === NEW).map((e) => e.stay_date)).toEqual([night]);
    });

    it("an edit saved with Skip keeps every change on the price, and Apply later judges them against the edited rule", async () => {
      const after = edited(settled, R.busy, { action_value: 20, rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.75 }] });
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = fake(clone(settled)).client as any;
      const marks = await skipMarksForRule(client, { hotelId: H, after: after as EngineRuleRow, at: T10, horizonDays: HORIZON }, engine.evaluate);
      // Where the edited rule no longer holds, the change stays (kept); where it does, it stays at its old amount.
      expect(marks.some((m) => m.w === "kept")).toBe(true);
      const skipped = await realRun(engine.evaluate, saveSkip(settled, after, marks, T10), T11);
      const kept = skipped.ladder_rule_state.filter((r) => r.rule_id === R.busy && r.is_active && r.skip_state === "kept");
      expect(kept.length).toBe(marks.filter((m) => m.w === "kept").length);
      expect(kept.every((r) => Number(r.action_value) === 15)).toBe(true);

      // Apply later (the Skip cleared): the popup's days are the prices that move.
      const reapplied: FakeRow = { ...after, skip_at: null };
      vi.setSystemTime(new Date(T20));
      const storedNow = skipped.pricing_rules.find((r) => r.id === R.busy)!;
      const preview = await previewRule(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fake(clone(skipped)).client as any,
        { hotelId: H, after: reapplied as EngineRuleRow, before: storedNow as EngineRuleRow, at: T20, horizonDays: HORIZON },
        engine.evaluate,
      );
      const applied = published(await realRun(engine.evaluate, saveApply(skipped, reapplied), T20));
      const without = published(await realRun(engine.evaluate, skipped, T20));
      expect(nightsDiffering(applied, without)).toEqual(preview.affected);
      expect(preview.affected.length).toBeGreaterThan(0);
    });

    it("an edit to a rule that is off moves no price until it is switched on", async () => {
      const t = clone(settled);
      const paused = t.pricing_rules.find((r) => r.id === R.pausedBs)!;
      Object.assign(paused, { version: 2, action_value: 30 });
      const run = await realRun(engine.evaluate, t, T11);
      const without = await realRun(engine.evaluate, settled, T11);
      expect(nightsDiffering(published(run), published(without))).toEqual([]);
      // Its changes are still on the price, frozen.
      expect(run.pickup_event.filter((e) => e.rule_id === R.pausedBs && e.retired_at == null).length).toBeGreaterThan(0);
    });
  });
}

describe("Skip after an edit to a booking speed rule that is on", () => {
  // A change the Skip leaves on the price keeps covering the weaker rules it
  // covered at the Skip: it ranks as it was made, not as the edited rule.
  // Lowering Surging's amount (or making it fixed, changing its speed, or
  // making it a standard rule) must not let Much Faster or Faster raise
  // again on bookings Surging's change already covered. Seeds 5, 31 and 43 are hotels where Surging's
  // changes are on the price over a weaker raise.
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
    it.each([5, 31, 43])(`hotel seed %i on the ${engine.name}: no price moves`, async (seedNo) => {
      engine.reset();
      vi.setSystemTime(new Date(T10));
      const t = await settle(engine.evaluate, seedNo);
      const without = await realRun(engine.evaluate, notActingById(t, R.bsSurging), T11);
      const withoutMf = await realRun(engine.evaluate, notActingById(t, R.bsMuchFaster), T11);
      const moved: Record<string, string[]> = {};
      for (const e of EDITS) {
        const after = edited(t, e.id, e.patch);
        vi.setSystemTime(new Date(T10));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = fake(clone(t)).client as any;
        const marks = await skipMarksForRule(client, { hotelId: H, after: after as EngineRuleRow, at: T10, horizonDays: HORIZON }, engine.evaluate);
        const skipped = await realRun(engine.evaluate, saveSkip(t, after, marks, T10), T11);
        const base = e.id === R.bsSurging ? without : withoutMf;
        moved[e.name] = nightsDiffering(published(skipped), published(base));
      }
      // An edit to a rule that is off moves no price either: its changes
      // stay on, frozen, and cover what they covered.
      const paused = notActingById(t, R.bsSurging);
      const offEdit = clone(paused);
      const afterOff = { ...withVersionRanks(paused, edited(paused, R.bsSurging, { action_value: 10 })), is_active: false };
      offEdit.pricing_rules = [...offEdit.pricing_rules.filter((r) => r.id !== R.bsSurging), afterOff];
      moved["Surging edited to +10% while off"] = nightsDiffering(published(await realRun(engine.evaluate, offEdit, T11)), published(without));
      expect(moved).toEqual(Object.fromEntries([...EDITS.map((e) => e.name), "Surging edited to +10% while off"].map((n) => [n, []])));
    }, 240_000);
  }
});

describe("which nights the preview runs", () => {
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
