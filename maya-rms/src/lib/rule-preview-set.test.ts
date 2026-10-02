/**
 * Several new rules at once (an import from PIE, added with Skip): the days
 * worked out for them are exactly the days Apply would change, with the
 * rules all on together and the floors and ceilings saved with them; Skip
 * holds those days for every one of them while every other day prices as
 * Apply does; and the floors and ceilings' own days, which the review
 * counts, are then the only days the import moves. On both copies of the
 * engine, on the preview fixture's hotel (made-up data).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { dryRunCapture } from "@/lib/engine/evaluate";
import { previewLimits, previewRuleSet, readOnlyClient, skipPlanForRules, type EngineRuleRow, type EvaluateFn, type LimitOverrides, type SkipPlan } from "@/lib/rule-preview";
import { ENGINES, FAMILY, H, HORIZON, KING, QUEEN, RT, SUITE, T10, TODAY, clone, fake, nightsDiffering, published, ruleRow, settle, uuid, type Tables } from "@/lib/rule-preview-fixture.test";
import type { FakeRow } from "@/lib/engine/fake-supabase.test";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const T11 = "2026-10-01T14:11:00.000Z";
const T20 = "2026-10-01T14:20:00.000Z";
const created = { created_at: T10, updated_at: T10 };
// Ids that sort in the import's order, as the import makes them.
const ID = (i: number) => uuid(`0e5a1b${String(i).padStart(2, "0")}`, 9);

/** An import: a ladder of raises with windows, a cut from today, and one with an undo beyond its window. */
function importedSet(): FakeRow[] {
  return [
    ruleRow(ID(0), { ...created, action_value: 10, cond: { occupancy_operator: "gt", occupancy_threshold: 0.3, dta_operator: "gt", dta_threshold_days: 9 } }),
    ruleRow(ID(1), { ...created, action_value: 5, cond: { occupancy_operator: "gt", occupancy_threshold: 0.55 } }),
    ruleRow(ID(2), { ...created, action_direction: "decrease", action_value: 10, cond: { occupancy_operator: "lt", occupancy_threshold: 0.25, dta_operator: "lt", dta_threshold_days: 15 } }),
    ruleRow(ID(3), { ...created, action_value: 12, cond: { occupancy_operator: "gt", occupancy_threshold: 0.45, dta_operator: "gt", dta_threshold_days: 4 } }),
    ruleRow(ID(4), { ...created, action_direction: "decrease", action_value: 10.7143, cond: { occupancy_operator: "gt", occupancy_threshold: 0.45, dta_operator: "gt", dta_threshold_days: 20 } }),
  ];
}

/** PIE's limits on two room types. */
const LIMITS: LimitOverrides = {
  [KING]: { floor_price: 150, ceiling_price: 215 },
  [SUITE]: { floor_price: 300, ceiling_price: 330 },
};

function withLimits(t: Tables, limits: LimitOverrides | undefined): Tables {
  const out = clone(t);
  for (const rt of out.room_types) {
    const l = limits?.[String(rt.id)];
    if (l) Object.assign(rt, l);
  }
  return out;
}

function saveApply(t: Tables, rules: FakeRow[], limits?: LimitOverrides): Tables {
  const out = withLimits(t, limits);
  out.pricing_rules = [...out.pricing_rules, ...rules.map((r) => ({ ...r, is_active: true, skip_at: null }))];
  return out;
}

/** save_rule's Skip for each rule: on, skip_at, its marks as held rows, its holds. */
function saveSkip(t: Tables, rules: FakeRow[], plans: Map<string, SkipPlan>, at: string, limits?: LimitOverrides): Tables {
  const out = withLimits(t, limits);
  out.pricing_rules = [...out.pricing_rules, ...rules.map((r) => ({ ...r, is_active: true, skip_at: at }))];
  for (const rule of rules) {
    const plan = plans.get(String(rule.id))!;
    for (const m of plan.marks) {
      expect(m.w).toBe("held");
      out.ladder_rule_state.push({
        rule_id: rule.id,
        rule_version: 1,
        stay_date: m.d,
        room_type_id: m.rt,
        is_active: true,
        activated_at: at,
        deactivated_at: null,
        suppressed_at: null,
        last_evaluated_at: at,
        action_kind: rule.action_type,
        action_direction: rule.action_direction,
        action_value: rule.action_value,
        skip_state: "held",
        skip_at: at,
      });
    }
    if (rule.is_pickup_rule) {
      out.rule_skip_hold = [
        ...(out.rule_skip_hold ?? []),
        ...plan.holdNights.flatMap((d) =>
          (rule.rule_affected_room_type as FakeRow[]).map((a) => ({ rule_id: rule.id, stay_date: d, room_type_id: a.room_type_id, skip_at: at, was_true: null })),
        ),
      ];
    }
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

async function fullDry(evaluate: EvaluateFn, t: Tables, at: string, rules: FakeRow[] | null, limits?: LimitOverrides) {
  const capture = dryRunCapture();
  vi.setSystemTime(new Date(at));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await evaluate(readOnlyClient(fake(clone(t)).client as any), H, at, HORIZON, {
    dryRun: { capture, ...(rules ? { rules } : {}), ...(limits ? { roomTypeLimits: limits } : {}) },
  });
  return capture.prices;
}

const CASES: { name: string; rules: () => FakeRow[]; limits?: LimitOverrides }[] = [
  { name: "an import of standard rules", rules: importedSet },
  { name: "an import of standard rules with floors and ceilings", rules: importedSet, limits: LIMITS },
  {
    name: "an import where one rule was edited into a booking speed rule",
    rules: () => [
      ...importedSet().slice(0, 2),
      ruleRow(ID(5), { ...created, priority: 118, action_value: 6, cond: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 3 }, affected: [KING, QUEEN] }),
    ],
    limits: { [FAMILY]: { floor_price: 200, ceiling_price: 260 } },
  },
];

for (const engine of ENGINES) {
  describe(`the days for rules added together, on the ${engine.name}`, () => {
    let settled: Tables;
    beforeEach(async () => {
      engine.reset();
      vi.setSystemTime(new Date(T10));
      settled ??= await settle(engine.evaluate);
    }, 120_000);

    it.each(CASES)("$name: the days shown are the days Apply changes", async (c) => {
      const t = clone(settled);
      const rules = c.rules();
      const truth = nightsDiffering(await fullDry(engine.evaluate, t, T10, rules, c.limits), await fullDry(engine.evaluate, t, T10, null, c.limits));
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = fake(clone(t)).client as any;
      const input = { hotelId: H, rules: rules as EngineRuleRow[], limits: c.limits, at: T10, horizonDays: HORIZON };
      const whole = await previewRuleSet(client, input, engine.evaluate);
      const chunks = await Promise.all([
        previewRuleSet(client, { ...input, to: addDays(TODAY, 9) }, engine.evaluate),
        previewRuleSet(client, { ...input, from: addDays(TODAY, 10), to: addDays(TODAY, 24) }, engine.evaluate),
        previewRuleSet(client, { ...input, from: addDays(TODAY, 25) }, engine.evaluate),
      ]);
      expect(truth.length).toBeGreaterThan(0);
      expect(whole.affected).toEqual(truth);
      expect(chunks.flatMap((x) => x.affected)).toEqual(truth);
      expect(whole.kind).toBe(rules.some((r) => r.is_pickup_rule) ? "event" : "standard");
      for (const night of whole.affected) expect(whole.roomTypesChanged[night]).toBeGreaterThan(0);

      // Apply: every rule saved on and the limits set, then the run the sync makes.
      const applied = published(await realRun(engine.evaluate, saveApply(t, rules, c.limits), T10));
      const without = published(await realRun(engine.evaluate, withLimits(t, c.limits), T10));
      expect(nightsDiffering(applied, without)).toEqual(whole.affected);
    }, 120_000);

    it.each(CASES)("$name: Skip holds the days shown for every rule, and every other day prices as Apply does", async (c) => {
      const t = clone(settled);
      const rules = c.rules();
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = fake(clone(t)).client as any;
      const input = { hotelId: H, rules: rules as EngineRuleRow[], limits: c.limits, at: T10, horizonDays: HORIZON };
      const preview = await previewRuleSet(client, input, engine.evaluate);
      const plans = await skipPlanForRules(client, input, preview.affected, engine.evaluate);
      expect([...plans.keys()].sort()).toEqual(rules.map((r) => String(r.id)).sort());
      const held = new Set(preview.affected);
      const skipped = await realRun(engine.evaluate, saveSkip(t, rules, plans, T10, c.limits), T11);
      const none = await realRun(engine.evaluate, withLimits(t, c.limits), T11);
      const applied = await realRun(engine.evaluate, saveApply(t, rules, c.limits), T11);
      const heldMoved = nightsDiffering(published(skipped), published(none)).filter((d) => held.has(d));
      const otherMoved = nightsDiffering(published(skipped), published(applied)).filter((d) => !held.has(d));
      expect(heldMoved).toEqual([]);
      expect(otherMoved).toEqual([]);
      // The next run, nothing new: the same.
      const again = await realRun(engine.evaluate, skipped, T20);
      expect(nightsDiffering(published(again), published(await realRun(engine.evaluate, none, T20))).filter((d) => held.has(d))).toEqual([]);
    }, 120_000);

    it.each(CASES.filter((c) => c.limits))(
      "$name: with Skip, the only days the import moves are the floors and ceilings' own, as the review counts them",
      async (c) => {
        const t = clone(settled);
        const rules = c.rules();
        vi.setSystemTime(new Date(T10));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = fake(clone(t)).client as any;
        const counted = await previewLimits(client, { hotelId: H, limits: c.limits!, at: T10, horizonDays: HORIZON }, engine.evaluate);
        expect(counted).toMatchObject({ today: TODAY, horizonDays: HORIZON, nightsChecked: HORIZON * 2 });
        // The limits alone, set and run as the sync runs, against the hotel as it is.
        const today = published(await realRun(engine.evaluate, t, T11));
        const limitsOnly = nightsDiffering(published(await realRun(engine.evaluate, withLimits(t, c.limits), T11)), today);
        expect(limitsOnly.length).toBeGreaterThan(0);
        expect(counted.limitsAffected).toEqual(limitsOnly);
        // The import as the route saves it: the rules on with Skip on the days worked out, and the limits set.
        const input = { hotelId: H, rules: rules as EngineRuleRow[], limits: c.limits, at: T10, horizonDays: HORIZON };
        const days = await previewRuleSet(client, input, engine.evaluate);
        const plans = await skipPlanForRules(client, input, days.affected, engine.evaluate);
        const skipped = published(await realRun(engine.evaluate, saveSkip(t, rules, plans, T10, c.limits), T11));
        expect(nightsDiffering(skipped, today)).toEqual(counted.limitsAffected);
        // No limits: nothing to count.
        expect((await previewLimits(client, { hotelId: H, limits: {}, at: T10, horizonDays: HORIZON }, engine.evaluate)).limitsAffected).toEqual([]);
      },
      120_000,
    );

    it("with no days worked out, Skip holds every day each rule could act on", async () => {
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = fake(clone(settled)).client as any;
      const rules = importedSet();
      const plans = await skipPlanForRules(client, { hotelId: H, rules: rules as EngineRuleRow[], at: T10, horizonDays: HORIZON }, "all", engine.evaluate);
      // The cut (under 15 days before arrival) reaches tonight and the next 14 nights only; the rest, every night.
      expect(plans.get(ID(2))!.holdNights).toEqual(Array.from({ length: 15 }, (_, i) => addDays(TODAY, i)));
      expect(plans.get(ID(1))!.holdNights).toHaveLength(HORIZON);
      expect(RT).toContain(KING);
    }, 120_000);
  });
}
