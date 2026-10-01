/**
 * PIE's rules and the MAYA rules the import makes give the same price, for
 * every occupancy and every day before arrival.
 *
 * A small PIE simulator: every triggered rule (on, its occupancy compare
 * true, the night inside its booking window and dates) is applied to the
 * current rate in turn, a percent multiplying and an amount adding, and the
 * result held inside the floor and ceiling. Against it:
 *
 *   1. MAYA's own condition, stacking and clamping functions, on both
 *      copies of the engine, over every occupancy (in half percents) and
 *      every day of the pricing window;
 *   2. the whole engine (evaluateHotel, both copies) on a property whose
 *      nights sit on and around every threshold and window edge, the rules
 *      saved the way the import saves them (parseDraft and planRuleChange),
 *      the prices it publishes read back.
 *
 * Exact to the cent, except: a window bounded at both ends becomes a rule
 * and its undo beyond the far end, and a percent's undo is kept to 4 places,
 * so there a price can be a cent off (the review says so); and a percent
 * with an amount on the same night depends on the order PIE triggered them
 * in, which the list doesn't show (the review flags it, and the test below
 * shows the order matters).
 *
 * Every name and number here is made up.
 */
import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { parseDraft, planRuleChange } from "@/lib/rule-save";
import { uiActionToDb } from "@/lib/rules-store";
import type { EngineRule } from "@/types/domain";
import * as appConditions from "@/lib/engine/conditions";
import * as appPricing from "@/lib/engine/pricing";
import * as appScope from "@/lib/engine/scope";
import * as edgeConditions from "../../../supabase/functions/_shared/engine/conditions";
import * as edgePricing from "../../../supabase/functions/_shared/engine/pricing";
import * as edgeScope from "../../../supabase/functions/_shared/engine/scope";
import { ENGINES, fake, published } from "@/lib/rule-preview-fixture.test";
import type { FakeRow } from "@/lib/engine/fake-supabase.test";
import type { PieDescription } from "./description";
import { PIE_COPY, planImport, type ImportDraft, type ImportItem, type MayaRoomType } from "./map";
import { mergeReads } from "./merge";
import type { PieRowRead } from "./read";

const TODAY = "2026-10-01";
const NIGHTS = 396;

/* ── The PIE simulator ────────────────────────────────────────── */

type SimRule = PieDescription & { on: boolean; start: string | null; end: string | null };

function occupancyTrue(r: SimRule, occupancyPct: number): boolean {
  switch (r.occupancyOp) {
    case "gt":
      return occupancyPct > r.threshold;
    case "lt":
      return occupancyPct < r.threshold;
    case "gte":
      return occupancyPct >= r.threshold;
    case "lte":
      return occupancyPct <= r.threshold;
    case "eq":
      return occupancyPct === r.threshold;
  }
}

/** PIE's price for a night: `booked` of `rooms` sold, `days` before arrival. */
function pie(
  rules: readonly SimRule[],
  night: { base: number; booked: number; rooms: number; days: number; date: string; floor: number; ceiling: number },
): number {
  let p = night.base;
  const occupancyPct = (night.booked * 100) / night.rooms;
  for (const r of rules) {
    if (!r.on || !occupancyTrue(r, occupancyPct)) continue;
    if (r.window && (night.days < r.window.from || night.days > r.window.to)) continue;
    if ((r.start && night.date < r.start) || (r.end && night.date > r.end)) continue;
    const sign = r.direction === "raise" ? 1 : -1;
    p = r.kind === "percent" ? p * (1 + (sign * r.amount) / 100) : p + sign * r.amount;
  }
  p = Math.round(p * 100) / 100;
  return Math.min(night.ceiling, Math.max(night.floor, p));
}

/* ── Rule sets (made up) ──────────────────────────────────────── */

type Spec = { name: string; desc: string; on?: boolean; start?: string; end?: string };

const LADDER: Spec[] = [
  { name: "Over 20, far out", desc: "Raise rate by 10.00 % when occupancy is greater than 20.00 % and when booking 80-900 days in advance" },
  { name: "Over 30", desc: "Raise rate by 10.00 % when occupancy is greater than 30.00 % and when booking 50-600 days in advance" },
  { name: "Over 45", desc: "Raise rate by 10.00 % when occupancy is greater than 45.00 % and when booking 30-600 days in advance" },
  { name: "Over 60", desc: "Raise rate by 10.00 % when occupancy is greater than 60.00 % and when booking 20-600 days in advance" },
  { name: "Over 70", desc: "Raise rate by 5.00 % when occupancy is greater than 70.00 % and when booking 18-600 days in advance" },
  { name: "Over 78", desc: "Raise rate by 5.00 % when occupancy is greater than 78.00 % and when booking 10-600 days in advance" },
  { name: "Over 86", desc: "Raise rate by 15.00 % when occupancy is greater than 86.00 %" },
  { name: "Over 94", desc: "Raise rate by 12.00 % when occupancy is greater than 94.00 %" },
];

const RAISES_AND_CUTS: Spec[] = [
  { name: "Filling", desc: "Raise rate by 10.00 % when occupancy is greater than 30.00 % and when booking 55-999 days in advance" },
  { name: "Busy", desc: "Raise rate by 10.00 % when occupancy is greater than 40.00 % and when booking 40-999 days in advance" },
  { name: "Very busy", desc: "Raise rate by 10.00 % when occupancy is greater than 65.00 % and when booking 40-999 days in advance" },
  { name: "Packed", desc: "Raise rate by 5.00 % when occupancy is greater than 82.00 % and when booking 12-999 days in advance" },
  { name: "Slow month", desc: "Lower rate by 10.00 % when occupancy is lower than 18.00 % and when booking today-30 days in advance" },
  { name: "Last nights", desc: "Lower rate by 10.00 % when occupancy is lower than 45.00 % and when booking today-3 days in advance", on: false },
  { name: "At least half", desc: "Raise rate by 4.00 % when occupancy is greater than or equal to 50.00 %" },
  { name: "Autumn", desc: "Raise rate by 6.00 % when occupancy is greater than 25.00 %", start: "11/02/2026", end: "11/28/2026" },
];

const AMOUNTS: Spec[] = [
  { name: "Plus 15", desc: "Raise rate by 15.00 when occupancy is greater than 50.00 %" },
  { name: "Plus 20 mid", desc: "Raise rate by 20.00 when occupancy is greater than 70.00 % and when booking 14-60 days in advance" },
  { name: "Minus 12.50", desc: "Lower rate by 12.50 when occupancy is lower than 30.00 % and when booking today-21 days in advance" },
  { name: "Minus 7 mid", desc: "Lower rate by 7.00 when occupancy is less than 35.00 % and when booking 5-45 days in advance" },
];

const PERCENT_SPLITS: Spec[] = [
  { name: "Mid raise", desc: "Raise rate by 10.00 % when occupancy is greater than 50.00 % and when booking 14-60 days in advance" },
  { name: "Mid cut", desc: "Lower rate by 15.00 % when occupancy is lower than 25.00 % and when booking 3-20 days in advance" },
  { name: "Top", desc: "Raise rate by 8.00 % when occupancy is greater than 80.00 %" },
];

const SETS: { name: string; specs: Spec[]; cent: boolean }[] = [
  { name: "a ladder of raises with windows from A days", specs: LADDER, cent: false },
  { name: "raises, cuts from today, one off, 'or equal to' and dates", specs: RAISES_AND_CUTS, cent: false },
  { name: "fixed amounts, two with windows bounded at both ends", specs: AMOUNTS, cent: false },
  { name: "percents with windows bounded at both ends", specs: PERCENT_SPLITS, cent: true },
];

/* ── The import, as MAYA rules ────────────────────────────────── */

const ROOMS: MayaRoomType[] = [
  { id: "a0000000-0000-4000-8000-000000000001", name: "Garden", counts_as_room: true, floor_price: 60, ceiling_price: 400 },
  { id: "a0000000-0000-4000-8000-000000000002", name: "Loft", counts_as_room: true, floor_price: 90, ceiling_price: 320 },
];
const ROOM_COUNTS = [60, 40];
const TOTAL_ROOMS = 100;

function rowOf(s: Spec): PieRowRead {
  return {
    name: s.name,
    description: s.desc,
    mode: "auto",
    type: "occupancy",
    typeText: "Occupancy",
    active: s.on !== false,
    startDate: s.start ?? "N/A",
    endDate: s.end ?? "N/A",
    cutOff: false,
    y: 0,
  };
}

function imported(specs: Spec[]): { items: ImportItem[]; sim: SimRule[]; drafts: ImportDraft[] } {
  let n = 0;
  const random = () => `${(n++).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const merged = mergeReads([{ width: 2000, height: 1200, columns: null, rows: specs.map(rowOf), limits: { master: null, byType: [] } }]);
  const { items } = planImport(merged, ROOMS, { today: TODAY, random });
  for (const item of items) expect(item.status).toBe("ready");
  const sim = merged.rules.map((r, i): SimRule => {
    if (!r.parsed.ok) throw new Error("unread");
    return { ...r.parsed.rule, on: items[i].on, start: items[i].drafts[0].start_date, end: items[i].drafts[0].end_date };
  });
  // Created on or off, as their switch was.
  const drafts = items.filter((i) => i.on).flatMap((i) => i.drafts);
  return { items, sim, drafts };
}

/** A draft as the engine reads it (the fields evaluate.ts maps a stored rule to). */
function engineRule(d: ImportDraft): EngineRule {
  return {
    id: d.id,
    hotel_id: "h1",
    name: d.rule_name,
    is_active: true,
    version: 1,
    start_date: d.start_date,
    end_date: d.end_date,
    is_annual: false,
    dow_mask: 127,
    ...uiActionToDb(d.action),
    priority: 100,
    is_pickup_rule: false,
    condition: d.condition,
    signal_room_type_ids: d.signal_room_type_ids,
    affected_room_type_ids: d.affected_room_type_ids,
    created_at: TODAY,
    updated_at: TODAY,
    undo_on_cancellation: true,
  };
}

/* ── 1. MAYA's own functions, every occupancy and day ─────────── */

const FUNCTIONS = [
  { name: "app engine", conditions: appConditions, pricing: appPricing, scope: appScope },
  { name: "edge engine", conditions: edgeConditions, pricing: edgePricing, scope: edgeScope },
];

for (const engine of FUNCTIONS) {
  describe(`PIE and MAYA price alike, every occupancy and day (${engine.name})`, () => {
    it.each(SETS)("$name", ({ specs, cent }) => {
      const { sim, drafts } = imported(specs);
      const rules = drafts.map(engineRule).sort((a, b) => (a.id < b.id ? -1 : 1));
      const rooms = 200;
      let cells = 0;
      let centOff = 0;
      let moved = 0;
      for (let day = 0; day < NIGHTS; day++) {
        const date = addDays(TODAY, day);
        for (let booked = 0; booked <= rooms; booked++) {
          for (const [base, floor, ceiling] of [
            [100, 1, 99_999.99],
            [137.35, 60, 400],
          ]) {
            const metrics = { occupancy: booked / rooms, dta: day, net_pickup_units: null, net_pickup_revenue: null };
            const on = rules.filter((r) => engine.scope.ruleScopeMatches(r, date, TODAY) && engine.conditions.ruleConditionsMatch(r, metrics));
            const effects = on.map((r) => ({ rule_id: r.id, action_kind: r.action_type, action_direction: r.action_direction, action_value: r.action_value }));
            const maya = engine.pricing.clampPrice(engine.pricing.applyAdjustments(base, effects, []), floor, ceiling).final;
            const want = pie(sim, { base, booked, rooms, days: day, date, floor, ceiling });
            cells++;
            if (Math.round(want * 100) !== Math.round(Math.min(ceiling, Math.max(floor, base)) * 100)) moved++;
            const diff = Math.round(Math.abs(maya - want) * 100);
            if (diff === 0) continue;
            if (!cent || diff > 1) expect({ day, booked, base, maya }).toEqual({ day, booked, base, maya: want });
            centOff++;
          }
        }
      }
      expect(cells).toBe(NIGHTS * 201 * 2);
      expect(moved).toBeGreaterThan(cells / 10);
      // A cent off only where a percent's undo sits on a price that lands on a half cent.
      if (cent) expect(centOff / cells).toBeLessThan(0.01);
    });
  });
}

describe("a percent and an amount on the same night", () => {
  it("can't match PIE exactly: the order matters, and the review says so", () => {
    const specs: Spec[] = [
      { name: "Pct", desc: "Raise rate by 10.00 % when occupancy is greater than 60.00 %" },
      { name: "Flat", desc: "Raise rate by 20.00 when occupancy is greater than 80.00 %" },
    ];
    const { items, sim } = imported(specs);
    const night = { base: 100, booked: 90, rooms: 100, days: 5, date: TODAY, floor: 1, ceiling: 99_999.99 };
    // 100 x 1.1 + 20 = 130, but 100 + 20, then x 1.1 = 132.
    expect(pie(sim, night)).toBe(130);
    expect(pie([...sim].reverse(), night)).toBe(132);
    expect(items.map((i) => i.notes.includes(PIE_COPY.mixed))).toEqual([false, true]);
  });
});

/* ── 2. The whole engine, on a property ───────────────────────── */

const H = "h1";
const T = "2026-10-01T14:00:00.000Z";

/** The occupancies (in rooms of 100) each night sits on: every threshold, a room either side, empty and full. */
function occupancies(sim: readonly SimRule[]): number[] {
  const out = new Set<number>([0, 1, 50, 99, 100]);
  for (const r of sim) for (const k of [Math.floor(r.threshold) - 1, Math.floor(r.threshold), Math.ceil(r.threshold), Math.ceil(r.threshold) + 1]) if (k >= 0 && k <= 100) out.add(k);
  return [...out].sort((a, b) => a - b);
}

/** The days the nights cover: every window edge and a day either side, and the far end. */
function days(sim: readonly SimRule[]): number[] {
  const out = new Set<number>([0, 1, 2, 100, 200, NIGHTS - 1]);
  for (const r of sim) {
    if (!r.window) continue;
    for (const d of [r.window.from - 1, r.window.from, r.window.from + 1, r.window.to - 1, r.window.to, r.window.to + 1]) if (d >= 0 && d < NIGHTS) out.add(d);
  }
  for (const r of sim) {
    for (const date of [r.start, r.end]) {
      if (!date) continue;
      const d = Math.round((Date.parse(date) - Date.parse(TODAY)) / 86_400_000);
      for (const x of [d - 1, d, d + 1]) if (x >= 0 && x < NIGHTS) out.add(x);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A property where night `day` has `booked[day]` of its 100 rooms sold
 * (spread over both room types) and a rate on record of `base` (and 1.8x for
 * the Loft), with the import's rules saved as the import saves them.
 */
async function property(rules: FakeRow[], booked: Map<number, number>, base: (day: number) => number) {
  const reservations: FakeRow[] = [];
  const calendar: FakeRow[] = [];
  let seq = 0;
  for (const [day, sold] of booked) {
    const stay = addDays(TODAY, day);
    const perType = [Math.min(sold, ROOM_COUNTS[0]), Math.max(0, sold - ROOM_COUNTS[0])];
    perType.forEach((n, t) => {
      for (let k = 0; k < n; k++) {
        seq++;
        reservations.push({
          id: `f0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
          hotel_id: H,
          external_reservation_id: `${seq}:1`,
          stay_date: stay,
          room_type_id: ROOMS[t].id,
          booking_date: "2026-09-01",
          booking_window_days: 30 + day,
          current_rate: 100,
          base_rate: 100,
          created_at: "2026-09-01T10:00:00.000Z",
        });
      }
    });
    ROOMS.forEach((rt, t) => calendar.push({ hotel_id: H, stay_date: stay, room_type_id: rt.id, price: t === 0 ? base(day) : Math.round(base(day) * 180) / 100 }));
  }
  return fake({
    hotels: [{ id: H, timezone: "UTC" }],
    room_types: ROOMS.map((rt, i) => ({
      id: rt.id,
      hotel_id: H,
      external_room_type_id: `ext-${i}`,
      name: rt.name,
      is_active: true,
      total_rooms: ROOM_COUNTS[i],
      floor_price: rt.floor_price,
      ceiling_price: rt.ceiling_price,
      counts_as_room: true,
    })),
    pricing_rules: rules,
    reservations,
    base_rate_calendar: calendar,
    published_price: [],
    ladder_rule_state: [],
    manual_price: [],
    hotel_closed_periods: [],
    assumption_challenges: [],
    room_type_out_of_service: [],
  });
}

/** The import's drafts saved the way POST /api/rules saves them (parseDraft, planRuleChange), in the engine's shape. */
async function saved(drafts: ImportDraft[]): Promise<FakeRow[]> {
  const db = fake({ room_types: ROOMS.map((rt) => ({ id: rt.id, hotel_id: H, is_active: true })), pricing_rules: [] });
  const out: FakeRow[] = [];
  for (const d of drafts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await planRuleChange(db.client as any, H, { intent: "create", ruleId: d.id, draft: parseDraft({ ...d }), at: T });
    out.push(plan.after as FakeRow);
  }
  return out;
}

for (const engine of ENGINES) {
  describe(`PIE and MAYA price alike, the whole engine (${engine.name})`, () => {
    it.each(SETS)(
      "$name",
      async ({ specs, cent }) => {
        engine.reset();
        const { sim, drafts } = imported(specs);
        const rules = await saved(drafts);
        const occ = occupancies(sim);
        const nightDays = days(sim);
        // Every edge day with every occupancy: one property per occupancy, the occupancies turned a step each time.
        const rounds = occ.length;
        const base = (day: number) => 89.99 + (day % 7) * 13.13;
        let compared = 0;
        // Nights where the rules moved the price (so the comparison is never empty-handed).
        let moved = 0;
        for (let round = 0; round < rounds; round++) {
          const booked = new Map<number, number>();
          nightDays.forEach((day, i) => booked.set(day, occ[(i + round) % occ.length]));
          const db = await property(rules, booked, base);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await engine.evaluate(db.client as any, H, T, NIGHTS, { nights: nightDays.map((d) => addDays(TODAY, d)) });
          const prices = published(db.tables);
          for (const day of nightDays) {
            const date = addDays(TODAY, day);
            ROOMS.forEach((rt, t) => {
              const b = t === 0 ? base(day) : Math.round(base(day) * 180) / 100;
              const want = pie(sim, { base: b, booked: booked.get(day)!, rooms: TOTAL_ROOMS, days: day, date, floor: rt.floor_price!, ceiling: rt.ceiling_price! });
              const got = prices.get(`${date}|${rt.id}`);
              if (Math.round(want * 100) !== Math.round(Math.min(rt.ceiling_price!, Math.max(rt.floor_price!, b)) * 100)) moved++;
              const diff = Math.round(Math.abs((got ?? NaN) - want) * 100);
              if (!(diff === 0 || (cent && diff === 1))) expect({ day, type: rt.name, booked: booked.get(day), got }).toEqual({ day, type: rt.name, booked: booked.get(day), got: want });
              compared++;
            });
          }
        }
        expect(compared).toBe(rounds * nightDays.length * ROOMS.length);
        expect(moved).toBeGreaterThan(compared / 10);
      },
      120_000,
    );
  });
}
