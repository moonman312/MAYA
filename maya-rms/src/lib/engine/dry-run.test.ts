/**
 * A dry run of the engine (evaluateHotel's dryRun option) is the real run
 * with its writes left out: at the same instant, on the same data, the
 * prices it arrives at are the ones a real run publishes, its ladder
 * decisions are the ones a real run writes, and it writes nothing at all.
 * On both copies of the engine, on a hotel whose rules have fired and whose
 * ladder rows are on (rule-preview-fixture.test.ts), over the whole window,
 * over a set of nights the way the pricing cadence asks for them, and with a
 * rule put in the run as the owner is about to save it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { dryRunCapture } from "./evaluate";
import { readOnlyClient } from "@/lib/rule-preview";
import {
  ENGINES,
  H,
  HORIZON,
  KING,
  QUEEN,
  R,
  T10,
  TODAY,
  clone,
  fake,
  published,
  ruleRow,
  settle,
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

const NEW_RULE = uuid("d1000000", 1);

/** The ladder rows a run left on, as the table holds them (for comparing a dry run's decisions). */
function ladderOn(tables: Tables): Map<string, string> {
  return new Map(
    (tables.ladder_rule_state ?? [])
      .filter((r) => r.is_active)
      .map((r) => [
        `${r.rule_id}|${String(r.stay_date).slice(0, 10)}|${r.room_type_id}`,
        `${r.rule_version}|${r.action_kind}|${r.action_direction}|${r.action_value}|${r.suppressed_at ?? ""}`,
      ]),
  );
}

for (const engine of ENGINES) {
  describe(`dry runs on the ${engine.name}`, () => {
    let settled: Tables;
    beforeEach(async () => {
      engine.reset();
      vi.setSystemTime(new Date(T10));
      settled ??= await settle(engine.evaluate);
    }, 120_000);

    const both = async (tables: Tables, opts: { nights?: string[]; rule?: Record<string, unknown> } = {}) => {
      const dryTables = clone(tables);
      const before = JSON.stringify(dryTables);
      const dry = fake(dryTables);
      const capture = dryRunCapture();
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await engine.evaluate(readOnlyClient(dry.client as any), H, T10, HORIZON, {
        ...(opts.nights ? { nights: opts.nights } : {}),
        dryRun: { capture, ...(opts.rule ? { rule: opts.rule, watch: String(opts.rule.id) } : {}) },
      });
      const realTables = clone(tables);
      if (opts.rule) {
        realTables.pricing_rules = [...realTables.pricing_rules.filter((r) => r.id !== opts.rule!.id), { ...opts.rule, is_active: true }];
      }
      const real = fake(realTables);
      vi.setSystemTime(new Date(T10));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await engine.evaluate(real.client as any, H, T10, HORIZON, opts.nights ? { nights: opts.nights } : {});
      return {
        capture,
        dryWrites: dry.calls.filter((c) => c.op !== "select"),
        // Every table as it was (a table the run only read is there, empty).
        dryUnchanged: Object.entries(dry.tables).every(
          ([name, rows]) => JSON.stringify(rows) === JSON.stringify((JSON.parse(before) as Tables)[name] ?? []),
        ),
        real: real.tables,
        before: tables,
      };
    };

    const expectSamePrices = (capture: ReturnType<typeof dryRunCapture>, real: Tables, nights: string[]) => {
      const realPrices = published(real);
      expect(capture.prices.size).toBeGreaterThan(0);
      for (const [key, price] of capture.prices) expect([key, price]).toEqual([key, realPrices.get(key)]);
      // Nothing the real run published on those nights is missing from the dry run.
      for (const [key, price] of realPrices) {
        if (nights.includes(key.slice(0, 10)) && !capture.unpriced.has(key)) expect([key, capture.prices.get(key)]).toEqual([key, price]);
      }
    };

    it("prices every night of the window as a real run does, and writes nothing", async () => {
      const r = await both(settled);
      expect(r.dryWrites).toEqual([]);
      expect(r.dryUnchanged).toBe(true);
      const window = Array.from({ length: HORIZON }, (_, i) => addDays(TODAY, i));
      expectSamePrices(r.capture, r.real, window);
      // The run changed something: rules fired and ladder rows moved.
      expect(r.real.pickup_event.length).toBeGreaterThan(0);
      expect(r.real.ladder_rule_state.filter((x) => x.is_active).length).toBeGreaterThan(0);
    }, 120_000);

    it("prices a set of nights as the cadence asks for them", async () => {
      const nights = [addDays(TODAY, 0), addDays(TODAY, 2), addDays(TODAY, 3), addDays(TODAY, 9), addDays(TODAY, 20), addDays(TODAY, 44)];
      const r = await both(settled, { nights });
      expect(r.dryWrites).toEqual([]);
      expectSamePrices(r.capture, r.real, nights);
      expect([...r.capture.prices.keys()].every((k) => nights.includes(k.slice(0, 10)))).toBe(true);
    }, 120_000);

    it("prices with a new rule in it as a real run with the rule saved, and records the rule's part", async () => {
      const rule = ruleRow(NEW_RULE, { action_type: "fixed", action_value: 11, cond: { occupancy_operator: "gt", occupancy_threshold: 0.5 }, affected: [KING, QUEEN], created_at: T10, updated_at: T10 });
      const r = await both(settled, { rule });
      expect(r.dryWrites).toEqual([]);
      const window = Array.from({ length: HORIZON }, (_, i) => addDays(TODAY, i));
      expectSamePrices(r.capture, r.real, window);
      // Its ladder decisions are the rows the real run wrote for it.
      const onReal = [...ladderOn(r.real).keys()].filter((k) => k.startsWith(`${NEW_RULE}|`)).sort();
      const activated = r.capture.ladderOps.filter((op) => op.kind === "activate").map((op) => `${op.rule.id}|${op.stayDate}|${op.roomTypeId}`).sort();
      expect(activated.length).toBeGreaterThan(0);
      expect(activated).toEqual(onReal);
      for (const op of r.capture.ladderOps) expect(r.capture.touched.has(op.stayDate)).toBe(true);
    }, 120_000);

    it("prices with a paused rule switched on as a real run does once it is switched on", async () => {
      const paused = settled.pricing_rules.find((x) => x.id === R.pausedBs)!;
      const r = await both(settled, { rule: { ...paused, is_active: true } });
      const window = Array.from({ length: HORIZON }, (_, i) => addDays(TODAY, i));
      expectSamePrices(r.capture, r.real, window);
      const ladderPaused = settled.pricing_rules.find((x) => x.id === R.pausedLadder)!;
      const l = await both(settled, { rule: { ...ladderPaused, is_active: true } });
      expectSamePrices(l.capture, l.real, window);
    }, 120_000);

    it("prices an edited rule as a real run does once the edit is saved", async () => {
      const busy = settled.pricing_rules.find((x) => x.id === R.busy)!;
      const edited = {
        ...busy,
        version: Number(busy.version) + 1,
        action_value: 20,
        rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.7 }],
        rule_affected_room_type: [{ room_type_id: KING }],
      };
      const r = await both(settled, { rule: edited });
      const window = Array.from({ length: HORIZON }, (_, i) => addDays(TODAY, i));
      expectSamePrices(r.capture, r.real, window);
      // The changes on the room types taken off its list came off.
      const left = r.real.ladder_rule_state.filter((x) => x.rule_id === R.busy && x.is_active && x.room_type_id !== KING);
      expect(left).toEqual([]);
    }, 120_000);

    it("a client that can only read refuses a write outright", async () => {
      const db = fake(clone(settled));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ro = readOnlyClient(db.client as any);
      expect(() => ro.from("published_price").insert({})).toThrow(/dry run tried to insert published_price/);
      expect(() => ro.rpc("pricing_mark_many", {})).toThrow(/dry run tried to call pricing_mark_many/);
      // A real run through it fails at its first write instead of moving a price.
      await expect(engine.evaluate(ro, H, T10, HORIZON)).rejects.toThrow(/dry run tried to/);
    });
  });
}
