/**
 * The last onboarding question (G24) on realistic years of bookings: an
 * owner who raises as nights fill and cuts late, one who raises only on
 * weekends, one whose rates never move but whose nights fill weeks out, and
 * one whose rates only wobble with the rate plan a guest picked.
 */
import { describe, expect, it } from "vitest";
import {
  NOTHING_TO_COPY_NOTE,
  readRateMoves,
  starterRuleSets,
  type RateHistoryRow,
  type RateMoves,
} from "../../../supabase/functions/_shared/onboarding/rate-moves";
import { computeStarterRules } from "../../../supabase/functions/_shared/onboarding/generate-rules";
import { INN, seasonal, usualLead, year } from "./__fixtures__/rate-history";

const NO_EM_DASH = /\u2014/;
const BANNED = /\b(learn|learns|knows|thinks|studies|analyses|analyzes|model|algorithm|AI)\b/i;

function allRules(sets: ReturnType<typeof starterRuleSets>) {
  return [...sets.none.rules, ...sets.automate_current.rules, ...sets.find_upside.rules];
}

describe("readRateMoves: an owner who raises as nights fill and cuts late", () => {
  // Their rate plan has weekday, weekend and summer rates. On top of it they
  // add 15% once a night is more than 70% booked, and take 10% off bookings
  // in the last week while a night is still under half booked.
  const { rows, rooms } = year({
    types: INN,
    occupancy: seasonal,
    lead: usualLead,
    price: ({ plan, full, daysAhead }) => (full > 0.7 ? plan * 1.15 : daysAhead < 7 && full < 0.5 ? plan * 0.9 : plan),
    seed: 7,
  });
  const moves = readRateMoves(rows, rooms);

  it("finds both moves, where they start and how big they are, on every night", () => {
    expect(moves.fill).toEqual([expect.objectContaining({ group: "all", thresholdPct: 70, changePct: 15 })]);
    expect(moves.late).toEqual([expect.objectContaining({ group: "all", withinDays: 7, changePct: -10 })]);
    expect(moves.fill[0].nights).toBeGreaterThanOrEqual(10);
    expect(moves.late[0].bookings).toBeGreaterThanOrEqual(20);
  });

  it("does not copy the weekend or summer rates their rate plan already holds", () => {
    // Weekend rates run 27% over weekday ones and summer 30% over the rest,
    // yet nothing beyond the two moves shows up: those differences are in the
    // base every rule starts from.
    const rules = starterRuleSets({ daysOfHistory: 365, moves }).automate_current.rules;
    expect(rules.map((r) => [r.name, r.condition, r.action.action_direction, r.action.action_value, r.dow_mask])).toEqual([
      ["Filling-up raise", { occupancy_operator: "gt", occupancy_threshold: 0.7 }, "increase", 15, 127],
      [
        "Last-minute cut",
        { dta_operator: "lt", dta_threshold_days: 7, occupancy_operator: "lt", occupancy_threshold: 0.5 },
        "decrease",
        10,
        127,
      ],
    ]);
  });

  it("says in each explanation what in the bookings it came from, with the rule's own numbers", () => {
    const [fill, late] = starterRuleSets({ daysOfHistory: 365, moves }).automate_current.rules;
    expect(fill.explanation).toBe(
      `On ${moves.fill[0].nights} nights in the past year, guests who booked once the night was more than 70% booked ` +
        "paid about 15% more than its early guests, who booked a week or more ahead while it was under 40% booked. " +
        "This rule does the same: once a night is more than 70% booked, it raises the price 15%.",
    );
    expect(late.explanation).toContain(`On ${moves.late[0].nights} nights in the past year`);
    expect(late.explanation).toContain("booked fewer than 7 days ahead, while the night was still under half booked, paid about 10% less");
    expect(late.explanation).toContain("when a night is fewer than 7 days away and under half booked, it cuts the price 10%");
  });

  it("with this answer the starter rules are the owner's moves, with no note", () => {
    const sets = starterRuleSets({ daysOfHistory: 365, moves });
    expect(sets.automate_current.note).toBeUndefined();
    expect(sets.automate_current.rules.every((r) => r.source === "your_moves" && !r.is_pickup_rule)).toBe(true);
    // No answer: the usual five, exactly as before the question was used.
    expect(sets.none.rules).toEqual(computeStarterRules({ daysOfHistory: 365 }));
  });
});

describe("readRateMoves: an owner who raises only on weekends", () => {
  const { rows, rooms } = year({
    types: INN,
    occupancy: seasonal,
    lead: usualLead,
    price: ({ plan, full, weekend }) => (weekend && full > 0.6 ? plan * 1.2 : plan),
    seed: 11,
  });
  const moves = readRateMoves(rows, rooms);

  it("keeps the raise to Friday and Saturday nights", () => {
    expect(moves.fill).toEqual([expect.objectContaining({ group: "weekend", thresholdPct: 60, changePct: 20 })]);
    expect(moves.late).toEqual([]);
    const [rule] = starterRuleSets({ daysOfHistory: 365, moves }).automate_current.rules;
    expect(rule).toMatchObject({ name: "Filling-up raise (Fri and Sat)", dow_mask: 48 });
    expect(rule.explanation).toContain(`On ${moves.fill[0].nights} Friday and Saturday nights in the past year`);
    expect(rule.explanation).toContain("once a Friday or Saturday night is more than 60% booked, it raises the price 20%");
  });
});

describe("readRateMoves: different moves on weekends and weekdays", () => {
  const { rows, rooms } = year({
    types: INN,
    occupancy: seasonal,
    lead: usualLead,
    price: ({ plan, full, weekend }) => (full > 0.7 ? plan * (weekend ? 1.25 : 1.1) : plan),
    seed: 5,
  });

  it("gives each its own rule, sized like each", () => {
    const moves = readRateMoves(rows, rooms);
    expect(moves.fill.map((m) => [m.group, m.thresholdPct, m.changePct])).toEqual([
      ["weekend", 70, 25],
      ["weekday", 70, 10],
    ]);
    expect(starterRuleSets({ daysOfHistory: 365, moves }).automate_current.rules.map((r) => [r.name, r.dow_mask])).toEqual([
      ["Filling-up raise (Fri and Sat)", 48],
      ["Filling-up raise (Sun to Thu)", 79],
    ]);
  });
});

describe("readRateMoves: rates that only wobble with the rate plan a guest picked", () => {
  // Non-refundable, flexible, breakfast included: up to 8% either side of the
  // plan rate at random, with no pattern to how full or how close the night is.
  const { rows, rooms } = year({
    types: INN,
    occupancy: seasonal,
    lead: usualLead,
    price: ({ plan, rand }) => plan * (0.92 + rand() * 0.16),
    seed: 3,
  });
  const moves = readRateMoves(rows, rooms);

  it("copies nothing, and says so over the usual five", () => {
    expect(moves.fill).toEqual([]);
    expect(moves.late).toEqual([]);
    const sets = starterRuleSets({ daysOfHistory: 365, moves });
    expect(sets.automate_current).toEqual({ rules: computeStarterRules({ daysOfHistory: 365 }), note: NOTHING_TO_COPY_NOTE });
  });
});

describe("find_upside: nights that fill weeks out at flat rates", () => {
  // A popular inn: most nights sell out, largely a month or more ahead, and
  // the owner never moves the rate plan's rate.
  const { rows, rooms } = year({
    types: INN,
    occupancy: (weekend, month, rand) => Math.min(1, 0.9 + rand() * 0.15),
    lead: (rand) => Math.floor(rand() * 75),
    price: ({ plan }) => plan,
    seed: 13,
  });
  const moves = readRateMoves(rows, rooms);

  it("sees the early fill and the flat rates", () => {
    expect(moves.fill).toEqual([]);
    expect(moves.filledEarly.nights).toBeGreaterThanOrEqual(10);
    expect(moves.filledEarly.share).toBeGreaterThanOrEqual(0.1);
    expect(moves.flatWhenNearlyFull).toEqual(expect.objectContaining({ changePct: 0 }));
  });

  it("raises bigger and adds the nearly-full raise, saying why", () => {
    const rules = starterRuleSets({ daysOfHistory: 365, moves }).find_upside.rules;
    expect(rules.map((r) => [r.name, r.action.action_direction, r.action.action_value])).toEqual([
      ["Slow-date rescue", "decrease", 15],
      ["Slow-date trim", "decrease", 7],
      ["Warm-date bump", "increase", 15],
      ["Hot-week surge", "increase", 30],
      ["Sudden-spike catcher", "increase", 30],
      ["Nearly-full raise", "increase", 10],
    ]);
    const warm = rules.find((r) => r.name === "Warm-date bump")!;
    expect(warm.explanation).toContain("can carry 15% more");
    expect(warm.explanation).toContain(
      `It raises 15% rather than the usual 10%: ${moves.filledEarly.nights} of your nights in the past year were already 90% booked 2 weeks or more before arrival.`,
    );
    expect(rules.find((r) => r.name === "Hot-week surge")!.explanation).toContain("raise 30% and ride");
    expect(rules.find((r) => r.name === "Sudden-spike catcher")!.explanation).toContain("immediate 30% raise");
    const nearly = rules.find((r) => r.name === "Nearly-full raise")!;
    expect(nearly).toMatchObject({ condition: { occupancy_operator: "gt", occupancy_threshold: 0.8 }, is_pickup_rule: false });
    expect(nearly.explanation).toContain(`On ${moves.flatWhenNearlyFull!.nights} nights in the past year`);
    // The cuts are the usual ones: finding money never cuts deeper.
    const usual = computeStarterRules({ daysOfHistory: 365 });
    expect(rules.find((r) => r.name === "Slow-date rescue")!.explanation).toBe(usual[0].explanation);
  });
});

describe("find_upside: an owner who already raises as nights fill, and books close in", () => {
  const { rows, rooms } = year({
    types: INN,
    occupancy: seasonal,
    lead: usualLead,
    price: ({ plan, full }) => (full > 0.7 ? plan * 1.15 : plan),
    seed: 17,
  });
  it("gets the usual five: no early fill to speak of, and they already raise on full nights", () => {
    const moves = readRateMoves(rows, rooms);
    expect(moves.fill).toHaveLength(1);
    const rules = starterRuleSets({ daysOfHistory: 365, moves }).find_upside.rules;
    expect(rules.map((r) => r.action.action_value)).toEqual([15, 7, 10, 25, 25]);
    expect(rules.every((r) => r.source === "upside")).toBe(true);
  });
});

describe("readRateMoves on thin or odd data", () => {
  it("reads nothing from a handful of bookings", () => {
    const rows: RateHistoryRow[] = [
      { stay_date: "2026-09-01", booking_date: "2026-08-01", room_type_id: "std", rate: 100 },
      { stay_date: "2026-09-01", booking_date: "2026-08-30", room_type_id: "std", rate: 140 },
    ];
    const moves = readRateMoves(rows, 10);
    expect(moves).toMatchObject({ nightsRead: 1, fill: [], late: [], flatWhenNearlyFull: null });
  });

  it("ignores rows with no rate, and ones booked after the night", () => {
    const moves = readRateMoves(
      [
        { stay_date: "2026-09-01", booking_date: "2026-09-03", room_type_id: "std", rate: 100 },
        { stay_date: "2026-09-02", booking_date: "2026-08-03", room_type_id: "std", rate: 0 },
      ],
      10,
    );
    expect(moves.nightsRead).toBe(0);
  });

  it("builds no set at all below the starter rules' history minimum", () => {
    const moves: RateMoves = { nightsRead: 0, fill: [], late: [], flatWhenNearlyFull: null, filledEarly: { nights: 0, share: 0 } };
    const sets = starterRuleSets({ daysOfHistory: 30, moves });
    expect([sets.none, sets.automate_current, sets.find_upside].map((s) => s.rules.length)).toEqual([0, 0, 0]);
  });
});

describe("the words", () => {
  it("every explanation and note is plain: no em dashes, and nothing claims MAYA thinks", () => {
    const histories = [
      year({ types: INN, occupancy: seasonal, lead: usualLead, price: ({ plan, full, daysAhead }) => (full > 0.7 ? plan * 1.15 : daysAhead < 7 && full < 0.5 ? plan * 0.9 : plan), seed: 7 }),
      year({ types: INN, occupancy: () => 0.95, lead: (r) => Math.floor(r() * 75), price: ({ plan }) => plan, seed: 13 }),
    ];
    for (const h of histories) {
      const sets = starterRuleSets({ daysOfHistory: 365, moves: readRateMoves(h.rows, h.rooms) });
      for (const r of allRules(sets)) {
        expect(r.explanation).not.toMatch(NO_EM_DASH);
        expect(r.explanation).not.toMatch(BANNED);
      }
    }
    expect(NOTHING_TO_COPY_NOTE).not.toMatch(NO_EM_DASH);
    expect(NOTHING_TO_COPY_NOTE).not.toMatch(BANNED);
  });
});
