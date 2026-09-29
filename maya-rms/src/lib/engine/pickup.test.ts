import { describe, expect, it, vi } from "vitest";
import {
  FIRE_UNIQUE_INDEX,
  arrivalReads,
  basePriceKey,
  baselineTsFrom,
  bookingSpeedCountFrom,
  cancellableParts,
  candidateFor,
  comparePickupRules,
  countFromFireAt,
  countPickupToDayStart,
  fireHeadKey,
  insertPickupEvent,
  isWaiting,
  resetPickupInsertLogOnce,
  openFireHeads,
  rankedAsMade,
  versionRanksOf,
  pickupCountEndsAt,
  pickupCountsCompleteDays,
  pickupJudgesShortStretch,
  pickupTieBreakTrace,
  pickupWaitDays,
  pickupWindowOpensAt,
  recordArrivals,
  ruleWaitDays,
  runPickupPass,
  selectPickupWinner,
  waitAnchor,
  type FireHead,
  type OpenPickupFire,
  type RankedRule,
} from "./pickup";
import { fakeSupabase } from "./fake-supabase.test";
import { bookedBeforeKey, type BookedCount } from "./snapshots";
import type { EngineRule } from "@/types/domain";
import type { PickupCandidate, RuleMetrics } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";

function makeRule(overrides: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "r1",
    hotel_id: "h1",
    name: "Test",
    is_active: true,
    version: 1,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    priority: 100,
    is_pickup_rule: true,
    condition: {
      dta_operator: "lt",
      dta_threshold_days: 30,
      pickup_operator: "gt",
      pickup_threshold: 5,
      pickup_window_days: 3,
      pickup_metric: "room_nights",
    },
    signal_room_type_ids: ["rt1"],
    affected_room_type_ids: ["rt1"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const baseMetrics: RuleMetrics = {
  occupancy: 0.5,
  dta: 14,
  net_pickup_units: 6,
  net_pickup_revenue: 1200,
};

function makeCandidate(rule: EngineRule, rtId: string = "rt1", stayDate: string = "2026-07-15"): PickupCandidate {
  return {
    rule,
    metrics: baseMetrics,
    stay_date: stayDate,
    baseline_ts: "2026-07-12T02:30:00Z",
    affected_room_type_id: rtId,
    eval_ts: "2026-07-15T02:30:00Z",
    count_to: "2026-07-15T02:30:00Z",
    signal_booked_units_start: 10,
    signal_booked_units_end: 16,
    signal_booked_revenue_start: 2000,
    signal_booked_revenue_end: 3200,
    fire_seq: 1,
    cancel_check: "recount",
    pickup_units_arrived: null,
    pickup_revenue_arrived: null,
    window_from: null,
    window_since: null,
    window_to: null,
    window_bookings_at_fire: null,
    window_expected_at_fire: null,
    window_booking_keys: null,
    signal_set_key: "rt1",
  };
}

describe("pickup competition (§7.3, §15.5)", () => {
  it("single candidate wins unopposed", () => {
    const c = makeCandidate(makeRule());
    const winner = selectPickupWinner([c], new Map());
    expect(winner).toBe(c);
  });

  it("higher priority wins at the same change and bar (step 3)", () => {
    const ruleA = makeRule({ id: "rA", priority: 100 });
    const ruleB = makeRule({ id: "rB", priority: 200 });
    const cA = makeCandidate(ruleA);
    const cB = makeCandidate(ruleB);
    const winner = selectPickupWinner([cA, cB], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("more specific rule wins on priority tie (step 4)", () => {
    const ruleA = makeRule({
      id: "rA",
      priority: 100,
      condition: {
        dta_operator: "lt",
        dta_threshold_days: 30,
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 3,
        pickup_metric: "room_nights",
      },
    });
    const ruleB = makeRule({
      id: "rB",
      priority: 100,
      condition: {
        occupancy_operator: "gt",
        occupancy_threshold: 0.4,
        dta_operator: "lt",
        dta_threshold_days: 30,
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 3,
        pickup_metric: "room_nights",
      },
    });
    const cA = makeCandidate(ruleA);
    const cB = makeCandidate(ruleB);
    const winner = selectPickupWinner([cA, cB], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("stricter pickup threshold wins at the same change (step 2, gt)", () => {
    const ruleA = makeRule({ id: "rA", condition: { ...makeRule().condition, pickup_threshold: 5, pickup_operator: "gt" } });
    const ruleB = makeRule({ id: "rB", condition: { ...makeRule().condition, pickup_threshold: 8, pickup_operator: "gt" } });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("stricter pickup threshold wins at the same change (step 2, lt)", () => {
    const ruleA = makeRule({ id: "rA", condition: { ...makeRule().condition, pickup_threshold: 5, pickup_operator: "lt" } });
    const ruleB = makeRule({ id: "rB", condition: { ...makeRule().condition, pickup_threshold: 3, pickup_operator: "lt" } });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("larger adjustment value wins (step 1)", () => {
    const ruleA = makeRule({ id: "rA", action_value: 5 });
    const ruleB = makeRule({ id: "rB", action_value: 10 });
    const sd = "2026-07-15";
    const winner = selectPickupWinner(
      [makeCandidate(ruleA, "rt1", sd), makeCandidate(ruleB, "rt1", sd)],
      new Map([[basePriceKey(sd, "rt1"), 100]]),
    );
    expect(winner!.rule.id).toBe("rB");
  });

  it("older rule wins (step 5)", () => {
    const ruleA = makeRule({ id: "rA", created_at: "2026-01-01T00:00:00Z" });
    const ruleB = makeRule({ id: "rB", created_at: "2026-06-01T00:00:00Z" });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("rA");
  });

  it("lower id wins as final tie-break (step 6)", () => {
    const ruleA = makeRule({ id: "aaa" });
    const ruleB = makeRule({ id: "bbb" });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("aaa");
  });

  it("winner selection is deterministic across repeated calls", () => {
    const ruleA = makeRule({ id: "rA", priority: 150 });
    const ruleB = makeRule({ id: "rB", priority: 100 });
    const candidates = [makeCandidate(ruleA), makeCandidate(ruleB)];
    const basePrices = new Map<string, number>();

    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const w = selectPickupWinner(candidates, basePrices);
      results.add(w!.rule.id);
    }
    expect(results.size).toBe(1);
    expect(results.has("rA")).toBe(true);
  });

  it("per-room competition: overlapping affected sets compete on shared rooms (§13.2)", () => {
    const ruleX = makeRule({
      id: "rX",
      priority: 100,
      action_value: 5,
      affected_room_type_ids: ["standard"],
    });
    const ruleY = makeRule({
      id: "rY",
      priority: 100,
      action_value: 10,
      affected_room_type_ids: ["standard", "deluxe"],
      condition: {
        ...makeRule().condition,
        pickup_threshold: 5,
        pickup_operator: "gt",
      },
    });

    const sd = "2026-07-15";
    const stdWinner = selectPickupWinner(
      [makeCandidate(ruleX, "standard", sd), makeCandidate(ruleY, "standard", sd)],
      new Map([[basePriceKey(sd, "standard"), 100]]),
    );
    expect(stdWinner!.rule.id).toBe("rY");

    const dlxWinner = selectPickupWinner(
      [makeCandidate(ruleY, "deluxe", sd)],
      new Map([[basePriceKey(sd, "deluxe"), 200]]),
    );
    expect(dlxWinner!.rule.id).toBe("rY");
  });

  it("empty candidates returns null", () => {
    expect(selectPickupWinner([], new Map())).toBeNull();
  });

  describe("cross-operator threshold comparisons never decide the winner (regression)", () => {
    // P(gt, 10) vs Q(lt, 2): naive branching on the first candidate's
    // operator gave compare(P,Q) = 2-10 = -8 AND compare(Q,P) = 2-10 = -8 —
    // both claimed to go first, so the winner (and the sign of the price
    // move) depended on unspecified DB row order alone.
    function slowFastPair() {
      const fast = makeRule({
        id: "fast-gt",
        action_direction: "increase",
        action_value: 8,
        condition: { ...makeRule().condition, pickup_operator: "gt", pickup_threshold: 10 },
      });
      const slow = makeRule({
        id: "slow-lt",
        action_direction: "decrease",
        action_value: 5,
        condition: { ...makeRule().condition, pickup_operator: "lt", pickup_threshold: 2 },
      });
      return { fast, slow };
    }

    it("picks the same winner regardless of candidate array order", () => {
      const { fast, slow } = slowFastPair();
      const sd = "2026-07-15";
      const basePrices = new Map([[basePriceKey(sd, "rt1"), 100]]);
      const winnerForward = selectPickupWinner(
        [makeCandidate(fast, "rt1", sd), makeCandidate(slow, "rt1", sd)],
        basePrices,
      );
      const winnerReversed = selectPickupWinner(
        [makeCandidate(slow, "rt1", sd), makeCandidate(fast, "rt1", sd)],
        basePrices,
      );
      expect(winnerForward!.rule.id).toBe(winnerReversed!.rule.id);
    });

    it("falls through to the next tie-break level (adjustment size) rather than a coin flip", () => {
      // 8% beats 5%, unambiguously, once thresholds stop being compared
      // across incompatible operators.
      const { fast, slow } = slowFastPair();
      const sd = "2026-07-15";
      const basePrices = new Map([[basePriceKey(sd, "rt1"), 100]]);
      const winner = selectPickupWinner(
        [makeCandidate(fast, "rt1", sd), makeCandidate(slow, "rt1", sd)],
        basePrices,
      );
      expect(winner!.rule.id).toBe("fast-gt");
    });

    it("treats a null pickup_operator (booking-speed rules) the same way — falls through, never compares", () => {
      const bookingSpeedRule = makeRule({
        id: "bs-rule",
        action_direction: "decrease",
        action_value: 7,
        condition: {
          booking_speed_operator: "at_most",
          booking_speed_level: "slower",
          booking_speed_window_days: 7,
        },
      });
      const pickupRule = makeRule({
        id: "pu-rule",
        action_direction: "increase",
        action_value: 7,
        condition: { ...makeRule().condition, pickup_operator: "gt", pickup_threshold: 5 },
      });
      const sd = "2026-07-15";
      const basePrices = new Map([[basePriceKey(sd, "rt1"), 100]]);
      const forward = selectPickupWinner(
        [makeCandidate(bookingSpeedRule, "rt1", sd), makeCandidate(pickupRule, "rt1", sd)],
        basePrices,
      );
      const reversed = selectPickupWinner(
        [makeCandidate(pickupRule, "rt1", sd), makeCandidate(bookingSpeedRule, "rt1", sd)],
        basePrices,
      );
      expect(forward!.rule.id).toBe(reversed!.rule.id);
    });

    it("the audit trace never claims a threshold win across different operators", () => {
      const { fast, slow } = slowFastPair();
      const sd = "2026-07-15";
      const basePrices = new Map([[basePriceKey(sd, "rt1"), 100]]);
      // The same change, so the bar is what the trace reaches.
      const winner = makeCandidate({ ...fast, action_value: 5 }, "rt1", sd);
      const loser = makeCandidate(slow, "rt1", sd);
      expect(selectPickupWinner([loser, winner], basePrices)).toBe(winner);
      const trace = pickupTieBreakTrace(winner, loser, basePrices);
      const joined = trace.join(" | ");
      expect(joined).not.toMatch(/pickup_threshold\((gt|lt)\):/);
      expect(joined).toContain("not comparable");
    });
  });

  describe("the stronger rule is the one that changes the price more, then the one that asks more of the bookings", () => {
    // Owners can't set priority (every rule they make is 100), so what
    // ranks their rules must be what they can see: how much a rule changes
    // the price, and at the same change how demanding its condition is.
    // One key per rule, so the order never loops and never depends on the
    // order the rules were read in.
    const sd = "2026-07-15";
    const basePrices = new Map([[basePriceKey(sd, "rt1"), 100]]);
    const speed = (id: string, level: string, value: number, over: Partial<EngineRule> = {}) =>
      makeRule({
        id,
        action_value: value,
        condition: { booking_speed_operator: "at_least", booking_speed_level: level, booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
        ...over,
      });
    const pickup = (id: string, threshold: number, value: number) =>
      makeRule({ id, action_value: value, condition: { pickup_operator: "gt", pickup_threshold: threshold, pickup_window_days: 7, pickup_metric: "room_nights" } });
    const order = (rules: EngineRule[]) =>
      [...rules].sort((a, b) => comparePickupRules(a, b, 100, 100)).map((r) => r.id);
    const permutations = <T,>(xs: T[]): T[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

    it("a bigger change ranks ahead of a rule with more conditions", () => {
      const five = speed("five", "much_faster", 10, {
        condition: { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, dta_operator: "lt", dta_threshold_days: 60 },
      });
      const ten = speed("ten", "surging", 20);
      expect(selectPickupWinner([makeCandidate(five, "rt1", sd), makeCandidate(ten, "rt1", sd)], basePrices)!.rule.id).toBe("ten");
      expect(comparePickupRules(ten, five, 100, 100)).toBeLessThan(0);
    });

    it("at the same change, the faster Booking Speed level ranks ahead, whichever rule was made first", () => {
      for (const [fiveMade, tenMade] of [
        ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
        ["2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"],
      ]) {
        const five = speed("five", "much_faster", 10, { created_at: fiveMade });
        const ten = speed("ten", "surging", 10, { created_at: tenMade });
        expect(order([five, ten])).toEqual(["ten", "five"]);
      }
      // For cuts the slower level asks more.
      const cut = (id: string, level: string) =>
        speed(id, level, 10, {
          action_direction: "decrease",
          condition: { booking_speed_operator: "at_most", booking_speed_level: level, booking_speed_window_days: 30 },
        });
      expect(order([cut("slower", "slower"), cut("much-slower", "much_slower")])).toEqual(["much-slower", "slower"]);
    });

    it("at the same change, a rule that watches booking speed ranks ahead of a pickup count rule, however high its count", () => {
      // What the "?" panels say (STRONGER_RULE_LINE): the speed decides
      // between two Booking Speed rules; against a rule without one, having
      // one decides, before any pickup count or priority.
      for (const threshold of [0, 4, 50]) {
        expect(order([pickup("count", threshold, 10), speed("pace", "faster", 10)])).toEqual(["pace", "count"]);
        expect(order([makeRule({ ...pickup("count", threshold, 10), priority: 150 }), speed("pace", "faster", 10)])).toEqual(["pace", "count"]);
      }
      const cutCount = makeRule({ id: "cut-count", action_direction: "decrease", action_value: 10, condition: { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 7 } });
      const cutPace = speed("cut-pace", "slower", 10, { action_direction: "decrease", condition: { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30 } });
      expect(order([cutCount, cutPace])).toEqual(["cut-pace", "cut-count"]);
    });

    it("never loops: pickup and Booking Speed rules mixed rank the same whatever order they come in", () => {
      // Under the old order "more than 9" (+10%) beat "more than 4" (+20%)
      // on the count, a Booking Speed rule (+15%) beat "more than 9" on the
      // change, and "more than 4" beat it on the change: a loop, so the
      // winner depended on the order the database returned the rules in.
      const a = pickup("a", 9, 10);
      const b = speed("b", "faster", 15);
      const c = pickup("c", 4, 20);
      for (const p of permutations([a, b, c])) {
        expect(order(p)).toEqual(["c", "b", "a"]);
        expect(selectPickupWinner(p.map((r) => makeCandidate(r, "rt1", sd)), basePrices)!.rule.id).toBe("c");
      }
    });

    it("is transitive over every mix of kinds, directions, changes and priorities", () => {
      const rules: EngineRule[] = [
        pickup("p9-10", 9, 10),
        pickup("p4-20", 4, 20),
        pickup("p4-10", 4, 10),
        speed("s-surge-10", "surging", 10),
        speed("s-faster-15", "faster", 15),
        speed("s-much-10-p150", "much_faster", 10, { priority: 150 }),
        makeRule({ id: "fixed-10", action_type: "fixed", action_value: 10 }),
        makeRule({ id: "lt-cut-10", action_direction: "decrease", action_value: 10, condition: { pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 3 } }),
        speed("s-cut-10", "slower", 10, { action_direction: "decrease", condition: { booking_speed_operator: "at_most", booking_speed_level: "slower" } }),
        makeRule({ id: "rev-10", action_value: 10, condition: { pickup_operator: "gt", pickup_threshold: 500, pickup_window_days: 7, pickup_metric: "revenue" } }),
      ];
      const cmp = (x: EngineRule, y: EngineRule) => Math.sign(comparePickupRules(x, y, 100, 100));
      for (const x of rules) {
        for (const y of rules) {
          expect(cmp(x, y)).toBe(x === y ? 0 : -cmp(y, x));
          for (const z of rules) if (cmp(x, y) < 0 && cmp(y, z) < 0) expect(cmp(x, z)).toBeLessThan(0);
        }
      }
    });

    it("keeps the starter rules in their own order, and puts an owner's bigger change ahead of them", () => {
      const starters = [
        speed("spike", "surging", 25, { priority: 130 }),
        speed("week", "much_faster", 25, { priority: 125 }),
        speed("month", "faster", 10, { priority: 115 }),
      ];
      expect(order([...starters].reverse())).toEqual(["spike", "week", "month"]);
      const cuts = [
        speed("trim", "slower", 7, { priority: 105, action_direction: "decrease", condition: { booking_speed_operator: "is", booking_speed_level: "slower" } }),
        speed("rescue", "much_slower", 15, { priority: 110, action_direction: "decrease", condition: { booking_speed_operator: "at_most", booking_speed_level: "much_slower" } }),
      ];
      expect(order(cuts)).toEqual(["rescue", "trim"]);
      // An owner's rule is priority 100: a 20% raise on 10 bookings in a
      // week ranks ahead of the 10% month rule, and behind the 25% ones.
      expect(order([...starters, pickup("owner-ten", 9, 20)])).toEqual(["spike", "week", "owner-ten", "month"]);
      // At the same change and level a starter's priority decides.
      expect(order([speed("owner-surge", "surging", 25), starters[0]])).toEqual(["spike", "owner-surge"]);
    });
  });
});

describe("waits", () => {
  it("a booking speed rule waits its cooldown, a week by default and never under a day", () => {
    const bs = (cooldown: number | null) =>
      makeRule({
        condition: { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: cooldown },
      });
    expect(ruleWaitDays(bs(null))).toBe(7);
    expect(ruleWaitDays(bs(2))).toBe(2);
    expect(ruleWaitDays(bs(0))).toBe(1);
  });

  it("a pickup count rule waits its own window, and a rule with both waits the longer", () => {
    expect(ruleWaitDays(makeRule())).toBe(3);
    const mixed = makeRule({
      condition: {
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 7,
        pickup_metric: "room_nights",
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 30,
        booking_speed_cooldown_days: 2,
      },
    });
    expect(ruleWaitDays(mixed)).toBe(7);
    expect(ruleWaitDays(makeRule({ condition: { ...mixed.condition, pickup_window_days: 1 } }))).toBe(2);
  });

  it("a pickup count rule waits the wait chosen for it, shorter or longer than its window, never under a day", () => {
    const pickup = (cooldown: number | null | undefined, windowDays: 1 | 3 | 7 = 7) =>
      makeRule({
        condition: {
          pickup_operator: "gt",
          pickup_threshold: 5,
          pickup_window_days: windowDays,
          pickup_metric: "room_nights",
          pickup_cooldown_days: cooldown,
        },
      });
    expect(ruleWaitDays(pickup(2))).toBe(2);
    expect(ruleWaitDays(pickup(14, 3))).toBe(14);
    expect(ruleWaitDays(pickup(0))).toBe(1);
    // None chosen: its window, as before the choice existed.
    expect(ruleWaitDays(pickup(null))).toBe(7);
    expect(ruleWaitDays(pickup(undefined, 1))).toBe(1);
    expect(pickupWaitDays(pickup(2).condition)).toBe(2);
    expect(pickupWaitDays(pickup(null, 3).condition)).toBe(3);
  });

  it("a rule with both conditions waits the longer of its booking speed wait and its chosen pickup wait", () => {
    const mixed = (pickupCooldown: number | null, bsCooldown: number | null) =>
      makeRule({
        condition: {
          pickup_operator: "gt",
          pickup_threshold: 5,
          pickup_window_days: 7,
          pickup_metric: "room_nights",
          pickup_cooldown_days: pickupCooldown,
          booking_speed_operator: "at_least",
          booking_speed_level: "faster",
          booking_speed_window_days: 30,
          booking_speed_cooldown_days: bsCooldown,
        },
      });
    expect(ruleWaitDays(mixed(2, 1))).toBe(2);
    expect(ruleWaitDays(mixed(2, 3))).toBe(3);
    expect(ruleWaitDays(mixed(14, 3))).toBe(14);
    // Booking speed's unset wait is a week.
    expect(ruleWaitDays(mixed(2, null))).toBe(7);
    // Pickup's unset wait is its window.
    expect(ruleWaitDays(mixed(null, 1))).toBe(7);
  });

  it("the wait runs from the last fire, or from a price typed after the rule was made", () => {
    const rule = makeRule({ created_at: "2026-01-01T00:00:00Z" });
    const head = { maxFireSeq: 2, anchorAt: "2026-07-10T00:00:00Z", counted: 2, lastCountedAt: "2026-07-10T00:00:00Z" };
    expect(waitAnchor(rule, head, undefined)).toBe("2026-07-10T00:00:00Z");
    expect(waitAnchor(rule, head, { set_at: "2026-07-12T00:00:00Z" })).toBe("2026-07-12T00:00:00Z");
    expect(waitAnchor(rule, head, { set_at: "2026-07-01T00:00:00Z" })).toBe("2026-07-10T00:00:00Z");
    expect(waitAnchor(rule, undefined, undefined)).toBeNull();
    // A rule made after the price was typed is not held by it.
    const later = makeRule({ created_at: "2026-07-13T00:00:00Z" });
    expect(waitAnchor(later, undefined, { set_at: "2026-07-12T00:00:00Z" })).toBeNull();
  });

  it("a wait of N days from a change on hotel day D ends when day D+N begins, whatever the hour", () => {
    const NY = "America/New_York";
    // 02:30 UTC on the 12th is 22:30 on the 11th in New York: day D is the 11th.
    expect(isWaiting("2026-07-12T02:30:00Z", "2026-07-13", 3, NY)).toBe(true);
    expect(isWaiting("2026-07-12T02:30:00Z", "2026-07-14", 3, NY)).toBe(false);
    // In UTC the same change is on the 12th, so it waits through the 14th.
    expect(isWaiting("2026-07-12T02:30:00Z", "2026-07-14", 3, "UTC")).toBe(true);
    expect(isWaiting("2026-07-12T02:30:00Z", "2026-07-15", 3, "UTC")).toBe(false);
    // A change a minute before midnight and one a minute after midnight end a day apart.
    expect(isWaiting("2026-07-12T03:59:00Z", "2026-07-12", 1, NY)).toBe(false);
    expect(isWaiting("2026-07-12T04:01:00Z", "2026-07-12", 1, NY)).toBe(true);
    expect(isWaiting(null, "2026-07-15", 3, NY)).toBe(false);
  });

  it("a pickup window opens at the start of a hotel day: today so far and the days before for more, complete days for low", () => {
    const NY = "America/New_York";
    // "More than 5 in 3 days" on the 15th: the 13th, the 14th and the 15th so far.
    expect(pickupCountsCompleteDays(makeRule())).toBe(false);
    expect(baselineTsFrom(makeRule(), "2026-07-15", NY)).toBe("2026-07-13T04:00:00.000Z");
    expect(pickupCountEndsAt(makeRule(), "2026-07-15T19:00:00.000Z", "2026-07-15", NY)).toBe("2026-07-15T19:00:00.000Z");
    // "Fewer than 2 in 3 days": the 12th, 13th and 14th, ending where today began.
    const low = makeRule({
      action_direction: "decrease",
      condition: { pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 3, pickup_metric: "room_nights" },
    });
    expect(pickupCountsCompleteDays(low)).toBe(true);
    expect(baselineTsFrom(low, "2026-07-15", NY)).toBe("2026-07-12T04:00:00.000Z");
    expect(pickupCountEndsAt(low, "2026-07-15T19:00:00.000Z", "2026-07-15", NY)).toBe("2026-07-15T04:00:00.000Z");
    // "More than" a number under zero reads low too.
    const negative = makeRule({ condition: { pickup_operator: "gt", pickup_threshold: -2, pickup_window_days: 1, pickup_metric: "room_nights" } });
    expect(pickupCountsCompleteDays(negative)).toBe(true);
    expect(baselineTsFrom(negative, "2026-07-15", NY)).toBe("2026-07-14T04:00:00.000Z");
    // A one-day window for more is today so far.
    const oneDay = makeRule({ condition: { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" } });
    expect(baselineTsFrom(oneDay, "2026-07-15", NY)).toBe("2026-07-15T04:00:00.000Z");
    // Across the end of daylight saving time the day starts an hour later in UTC.
    expect(baselineTsFrom(oneDay, "2026-11-02", NY)).toBe("2026-11-02T05:00:00.000Z");
    expect(baselineTsFrom(oneDay, "2026-11-01", NY)).toBe("2026-11-01T04:00:00.000Z");
    const bs = makeRule({
      condition: { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30 },
    });
    expect(baselineTsFrom(bs, "2026-07-15", NY)).toBeNull();
  });

  it("a count of complete days ends where today began: today's bookings wait, today's cancellations count at once", () => {
    const low = makeRule({
      action_direction: "decrease",
      condition: { pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 3, pickup_metric: "room_nights" },
    });
    const dayStart = "2026-07-15T04:00:00.000Z";
    // 10 booked when the window opened, 13 now: 2 of those first seen today,
    // and one booked before today cancelled today, so 10 first seen before
    // today are still booked... plus the 1 that cancelled is gone: 11 left.
    const metrics: RuleMetrics = {
      occupancy: 0.5,
      dta: 10,
      net_pickup_units: 3,
      net_pickup_revenue: 300,
      pickup_block_reason: null,
      signal_booked_units_baseline: 10,
      signal_booked_revenue_baseline: 1000,
      signal_booked_units_now: 13,
      signal_booked_revenue_now: 1300,
    };
    const booked = new Map([[bookedBeforeKey("2026-07-15", dayStart), new Map([["rt1", { units: 11, revenue: 1100 }]])]]);
    expect(countPickupToDayStart(metrics, low, "2026-07-15", dayStart, booked)).toBe(true);
    expect(metrics).toMatchObject({
      net_pickup_units: 1,
      net_pickup_revenue: 100,
      signal_booked_units_now: 11,
      pickup_counted_to: dayStart,
    });
    // Nothing read at that instant: left as it was.
    const other = { ...metrics, net_pickup_units: 3, pickup_counted_to: undefined };
    expect(countPickupToDayStart(other, low, "2026-07-15", dayStart, new Map())).toBe(false);
    expect(other.net_pickup_units).toBe(3);
  });
});

describe("where a Booking Speed rule starts counting on a cell", () => {
  const bs = makeRule({
    condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 30, booking_speed_cooldown_days: 3 },
  });

  it("counts from the hotel day of its own last counted fire on the cell, that day split at the fire", () => {
    expect(bookingSpeedCountFrom(bs, "2026-07-10T15:00:00Z", undefined, "UTC")).toEqual({ from: "2026-07-10", since: "2026-07-10T15:00:00Z" });
    // 02:30 UTC on the 10th is still the 9th in New York.
    expect(bookingSpeedCountFrom(bs, "2026-07-10T02:30:00Z", undefined, "America/New_York")).toEqual({
      from: "2026-07-09",
      since: "2026-07-10T02:30:00Z",
    });
  });

  it("counts its whole window when it has no counted fire on the cell", () => {
    // Fires a typed price or an edit took off are not counted (pickup_fire_heads).
    expect(bookingSpeedCountFrom(bs, null, undefined, "UTC")).toBeNull();
    expect(bookingSpeedCountFrom(bs, undefined, undefined, "UTC")).toBeNull();
  });

  it("after a typed price, judges its whole window again: a fire from before the price doesn't cut it", () => {
    // A raise taken off for cancellations still counts, but it came before the price.
    expect(bookingSpeedCountFrom(bs, "2026-07-10T15:00:00Z", { set_at: "2026-07-11T09:00:00Z" }, "UTC")).toBeNull();
    // A fire after the price does.
    expect(bookingSpeedCountFrom(bs, "2026-07-15T15:00:00Z", { set_at: "2026-07-11T09:00:00Z" }, "UTC")).toEqual({
      from: "2026-07-15",
      since: "2026-07-15T15:00:00Z",
    });
  });

  it("means nothing to a rule that only counts pickup", () => {
    expect(bookingSpeedCountFrom(makeRule(), "2026-07-10T15:00:00Z", undefined, "UTC")).toBeNull();
  });

  it("for a rule that cuts, starts on the day after its cut and never splits a day: it reads complete days only", () => {
    const cut = makeRule({
      action_direction: "decrease",
      condition: { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 7 },
    });
    expect(bookingSpeedCountFrom(cut, "2026-07-10T15:00:00Z", undefined, "UTC")).toEqual({ from: "2026-07-11", since: null });
    // The cut's hotel day, not UTC's: 02:30 UTC on the 10th is the 9th in New York.
    expect(bookingSpeedCountFrom(cut, "2026-07-10T02:30:00Z", undefined, "America/New_York")).toEqual({ from: "2026-07-10", since: null });
    expect(bookingSpeedCountFrom(cut, null, undefined, "UTC")).toBeNull();
    expect(bookingSpeedCountFrom(cut, "2026-07-10T15:00:00Z", { set_at: "2026-07-11T09:00:00Z" }, "UTC")).toBeNull();
  });
});

describe("the fire a rule counts from on a cell (countFromFireAt)", () => {
  // Jake, 2026-09-24, option A: the newest change on the night and room
  // type by the rule itself or by a rule that adjusts the same way and
  // ranks ahead of it. A weaker rule's change never moves it.
  const NIGHT = "2026-07-20";
  const speed = (id: string, over: Partial<EngineRule> = {}) =>
    makeRule({
      id,
      condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 1 },
      ...over,
    });
  const heads = (fires: Record<string, string>) =>
    new Map<string, FireHead>(
      Object.entries(fires).map(([ruleId, at]) => [
        fireHeadKey(ruleId, NIGHT, "rt1"),
        { maxFireSeq: 1, anchorAt: at, counted: 1, lastCountedAt: at },
      ]),
    );
  const weak = speed("weak", { priority: 100, action_value: 10 });
  const strong = speed("strong", { priority: 120, action_value: 20 });
  const at = (rule: RankedRule, others: RankedRule[], fires: Record<string, string>) =>
    countFromFireAt(rule, others, heads(fires), NIGHT, "rt1", 100);

  it("is the rule's own newest counted fire when nothing stronger fired later", () => {
    expect(at(weak, [strong], { weak: "2026-07-10T15:00:00.000Z" })).toBe("2026-07-10T15:00:00.000Z");
    expect(at(weak, [strong], { weak: "2026-07-10T15:00:00.000Z", strong: "2026-07-09T15:00:00.000Z" })).toBe("2026-07-10T15:00:00.000Z");
    expect(at(weak, [strong], {})).toBeNull();
  });

  it("is a stronger rule's newer fire, even where the rule itself never fired", () => {
    expect(at(weak, [strong], { strong: "2026-07-11T09:00:00.000Z" })).toBe("2026-07-11T09:00:00.000Z");
    expect(at(weak, [strong], { weak: "2026-07-10T15:00:00.000Z", strong: "2026-07-11T09:00:00.000Z" })).toBe("2026-07-11T09:00:00.000Z");
  });

  it("never moves for a weaker rule's fire, or for a fire the other way", () => {
    expect(at(strong, [weak], { weak: "2026-07-11T09:00:00.000Z" })).toBeNull();
    expect(at(strong, [weak], { strong: "2026-07-10T15:00:00.000Z", weak: "2026-07-11T09:00:00.000Z" })).toBe("2026-07-10T15:00:00.000Z");
    const bigCut = speed("big-cut", { priority: 200, action_direction: "decrease", action_value: 30 });
    expect(at(weak, [bigCut], { "big-cut": "2026-07-11T09:00:00.000Z" })).toBeNull();
  });

  it("takes the newest of several stronger rules' fires, and skips the rule itself among the others", () => {
    const strongest = speed("strongest", { priority: 130, action_value: 25 });
    const fires = { weak: "2026-07-09T00:00:00.000Z", strong: "2026-07-12T09:00:00.000Z", strongest: "2026-07-11T09:00:00.000Z" };
    expect(at(weak, [weak, strongest, strong], fires)).toBe("2026-07-12T09:00:00.000Z");
    expect(at(strong, [weak, strong, strongest], fires)).toBe("2026-07-12T09:00:00.000Z");
    expect(at(strongest, [weak, strong], fires)).toBe("2026-07-11T09:00:00.000Z");
  });

  it("ranks the way the competition does: the bigger change, then the higher count, then priority, then more conditions", () => {
    const fires = { a: "2026-07-11T09:00:00.000Z" };
    const pickup = (id: string, threshold: number, over: Partial<EngineRule> = {}) =>
      makeRule({ id, condition: { pickup_operator: "gt", pickup_threshold: threshold, pickup_window_days: 7, pickup_metric: "room_nights" }, ...over });
    // The same change: more than 9 ranks ahead of more than 4.
    expect(at(pickup("b", 4), [pickup("a", 9)], fires)).toBe(fires.a);
    expect(at(pickup("b", 9), [pickup("a", 4)], fires)).toBeNull();
    // A bigger change ranks ahead of the higher count, and a higher
    // priority or an extra condition doesn't outrank a bigger change.
    expect(at(pickup("b", 9), [pickup("a", 4, { action_value: 20 })], fires)).toBe(fires.a);
    expect(at(pickup("b", 4, { action_value: 20 }), [pickup("a", 9, { priority: 150 })], fires)).toBeNull();
    expect(
      at(pickup("b", 4, { action_value: 20 }), [pickup("a", 4, { condition: { ...makeRule().condition, pickup_threshold: 4 } })], fires),
    ).toBeNull();
    // At the same change and count, the higher priority.
    expect(at(pickup("b", 9), [pickup("a", 9, { priority: 150 })], fires)).toBe(fires.a);
    // A fixed $30 raise outranks 20% of a $100 base.
    expect(at(speed("b", { action_value: 20 }), [speed("a", { action_type: "fixed", action_value: 30 })], fires)).toBe(fires.a);
  });

  it("counts a paused rule's fire, which stays on the price, from what ranking reads alone", () => {
    const paused: RankedRule = {
      id: "paused",
      version: 2,
      priority: 150,
      condition: { booking_speed_operator: "at_least" },
      action_type: "percent",
      action_direction: "increase",
      action_value: 25,
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(at(weak, [paused], { paused: "2026-07-11T09:00:00.000Z" })).toBe("2026-07-11T09:00:00.000Z");
  });

  it("gives an ISO instant however the database wrote the fire's time", () => {
    expect(at(weak, [strong], { strong: "2026-07-11 09:00:00+00" })).toBe("2026-07-11T09:00:00.000Z");
  });

  it("agrees with the competition on who goes first", () => {
    const rules = [
      speed("s1", { priority: 100, action_value: 10 }),
      speed("s2", { priority: 100, action_value: 20 }),
      speed("s3", { priority: 90, action_value: 50 }),
      makeRule({ id: "p1", priority: 100 }),
      makeRule({ id: "p2", priority: 100, condition: { pickup_operator: "gt", pickup_threshold: 9, pickup_window_days: 7 } }),
    ];
    const base = new Map([[basePriceKey(NIGHT, "rt1"), 100]]);
    const winner = selectPickupWinner(rules.map((r) => makeCandidate(r, "rt1", NIGHT)), base)!.rule;
    for (const other of rules) if (other !== winner) expect(comparePickupRules(winner, other, 100, 100)).toBeLessThan(0);
  });
});

describe("where a pickup count opens: the fires still on the night (openFireHeads)", () => {
  const NIGHT = "2026-10-01";
  const fire = (over: Partial<OpenPickupFire>): OpenPickupFire => ({
    id: "f1",
    rule_id: "raise",
    rule_version: 1,
    stay_date: NIGHT,
    affected_room_type_id: "rt1",
    applied_at: "2026-09-20T12:00:00.000Z",
    checked_at: over.checked_at ?? over.applied_at ?? "2026-09-20T12:00:00.000Z",
    count_end_ts: over.count_end_ts ?? over.checked_at ?? over.applied_at ?? "2026-09-20T12:00:00.000Z",
    fire_seq: 1,
    action_kind: "percent",
    action_direction: "increase",
    action_value: 10,
    cancel_check: "recount",
    baseline_start_ts: "2026-09-13T12:00:00.000Z",
    signal_booked_units_start: 0,
    signal_booked_units_end: 5,
    signal_booked_revenue_start: 0,
    signal_booked_revenue_end: 500,
    pickup_units_arrived_at_fire: 5,
    pickup_revenue_arrived_at_fire: 500,
    window_from: null,
    window_since: null,
    window_to: null,
    window_bookings_at_fire: null,
    window_expected_at_fire: null,
    window_booking_keys: null,
    signal_set_key: "rt1",
    ...over,
  });
  const raise = makeRule({ id: "raise" });
  const paused = makeRule({ id: "paused", is_active: false });
  const edited = makeRule({ id: "edited", version: 2 });

  it("takes each rule's newest open fire per night and room type, and how many are open, paused rules' included", () => {
    const heads = openFireHeads(
      [raise, paused],
      [
        fire({ id: "a", applied_at: "2026-09-20T12:00:00.000Z" }),
        fire({ id: "b", applied_at: "2026-09-22T12:00:00.000Z" }),
        fire({ id: "c", rule_id: "paused", applied_at: "2026-09-21T12:00:00.000Z" }),
        fire({ id: "d", affected_room_type_id: "rt2", applied_at: "2026-09-19T12:00:00.000Z" }),
      ],
      new Set(),
    );
    expect(heads.get(fireHeadKey("raise", NIGHT, "rt1"))).toMatchObject({ lastCountedAt: "2026-09-22T12:00:00.000Z", counted: 2 });
    expect(heads.get(fireHeadKey("paused", NIGHT, "rt1"))?.lastCountedAt).toBe("2026-09-21T12:00:00.000Z");
    expect(heads.get(fireHeadKey("raise", NIGHT, "rt2"))?.lastCountedAt).toBe("2026-09-19T12:00:00.000Z");
  });

  it("counts from when a fire was made, even once a cancellation check kept it and took its numbers again later", () => {
    const heads = openFireHeads(
      [raise],
      [fire({ id: "kept", applied_at: "2026-09-20T12:00:00.000Z", checked_at: "2026-09-22T12:05:00.000Z" })],
      new Set(),
    );
    expect(heads.get(fireHeadKey("raise", NIGHT, "rt1"))).toMatchObject({ lastCountedAt: "2026-09-20T12:00:00.000Z", counted: 1 });
  });

  it("leaves out a raise this run took off and one whose rule it wasn't given", () => {
    const heads = openFireHeads(
      [raise, edited],
      [
        fire({ id: "open", applied_at: "2026-09-20T12:00:00.000Z" }),
        fire({ id: "cancelled", applied_at: "2026-09-23T12:00:00.000Z" }),
        fire({ id: "orphan", rule_id: "deleted", applied_at: "2026-09-25T12:00:00.000Z" }),
      ],
      new Set(["cancelled"]),
    );
    expect([...heads.keys()]).toEqual([fireHeadKey("raise", NIGHT, "rt1")]);
    expect(heads.get(fireHeadKey("raise", NIGHT, "rt1"))).toMatchObject({ lastCountedAt: "2026-09-20T12:00:00.000Z", counted: 1 });
  });

  it("a raise of an older version still on the price covers what it counted, and doesn't count toward the alert", () => {
    // A rule edited while it was off keeps its changes on the price, frozen,
    // and so does one saved with Skip; a running rule's older changes are
    // taken off before this (firesToReset).
    const heads = openFireHeads(
      [edited],
      [fire({ id: "old", rule_id: "edited", rule_version: 1, applied_at: "2026-09-24T12:00:00.000Z" })],
      new Set(),
    );
    expect(heads.get(fireHeadKey("edited", NIGHT, "rt1"))).toMatchObject({ lastCountedAt: "2026-09-24T12:00:00.000Z", counted: 0 });
  });

  it("a change of an earlier version covers as it was made: its own amount and kind, and that version's priority and condition", () => {
    // Surging (+25%, at least Surging, priority 130) raised; the owner then
    // edited it to +10% at least Faster and chose Skip, which left the raise
    // on. Much Faster (+25%) ranked below it then, and still counts from it.
    const cond = (level: string): EngineRule["condition"] => ({
      booking_speed_operator: "at_least",
      booking_speed_level: level,
      booking_speed_window_days: 1,
      booking_speed_cooldown_days: 1,
    });
    const surging = makeRule({
      id: "surging",
      version: 2,
      priority: 130,
      action_value: 10,
      condition: cond("faster"),
      version_ranks: { "1": { priority: 130, condition: cond("surging") } },
    });
    const muchFaster = makeRule({ id: "much-faster", priority: 125, action_value: 25, condition: cond("much_faster") });
    const kept = fire({ id: "kept", rule_id: "surging", rule_version: 1, action_value: 25, applied_at: "2026-09-24T12:00:00.000Z" });
    const covered = (rule: RankedRule, fires: OpenPickupFire[]) =>
      countFromFireAt(muchFaster, [rule], openFireHeads([rule, muchFaster], fires, new Set()), NIGHT, "rt1", 100);
    expect(covered(surging, [kept])).toBe("2026-09-24T12:00:00.000Z");
    // A newer raise of the edited rule (+10%) covers nothing above it, and
    // doesn't hide the older one that does.
    const newer = fire({ id: "new", rule_id: "surging", rule_version: 2, action_value: 10, applied_at: "2026-09-25T12:00:00.000Z" });
    expect(covered(surging, [kept, newer])).toBe("2026-09-24T12:00:00.000Z");
    // Without a record of version 1 it ranks by its own +25% and the rule's
    // condition now (at least Faster), which Much Faster outranks.
    expect(covered({ ...surging, version_ranks: null }, [kept])).toBeNull();
    // The edited rule as it is now covers nothing: +10% is below +25%.
    expect(covered({ ...surging, version: 1, version_ranks: null }, [{ ...kept, action_value: 10 }])).toBeNull();
    // A raise stays a raise after an edit made the rule a cut.
    const nowACut = { ...surging, action_direction: "decrease" as const };
    expect(covered(nowACut, [kept])).toBe("2026-09-24T12:00:00.000Z");
    const cut = makeRule({ id: "cut", action_direction: "decrease", action_value: 5, condition: cond("slower") });
    expect(countFromFireAt(cut, [nowACut], openFireHeads([nowACut, cut], [kept], new Set()), NIGHT, "rt1", 100)).toBeNull();
  });

  it("reads version_ranks as save_rule writes them, and nothing else", () => {
    expect(rankedAsMade(raise, fire({}))).toBe(raise);
    expect(rankedAsMade(edited, fire({ rule_id: "edited", rule_version: 1, action_kind: "fixed", action_value: 30 }))).toMatchObject({
      id: "edited",
      action_type: "fixed",
      action_value: 30,
      priority: edited.priority,
    });
    expect(
      versionRanksOf({ "3": { priority: 125, condition: { booking_speed_operator: "at_least", booking_speed_level: "much_faster", pickup_threshold: "4" } } }),
    ).toEqual({
      "3": {
        priority: 125,
        condition: {
          occupancy_operator: null,
          dta_operator: null,
          pickup_operator: null,
          pickup_threshold: 4,
          pickup_metric: null,
          booking_speed_operator: "at_least",
          booking_speed_level: "much_faster",
        },
      },
    });
    expect(versionRanksOf(null)).toBeNull();
    expect(versionRanksOf([])).toBeNull();
    expect(versionRanksOf({ x: { priority: 1 }, "2": "no", "4": { priority: "high" } })).toBeNull();
  });

  it("so a stronger rule's raise that came off for cancellations covers no weaker rule, where the fire history would", () => {
    // pickup_fire_heads keeps a raise taken off for cancellations; the fires
    // still on the night don't, and they are what every rule counts from.
    const strong = makeRule({ id: "strong", action_value: 20 });
    const weak = makeRule({ id: "weak", action_value: 10 });
    const cancelledAt = "2026-09-23T12:00:00.000Z";
    const history = new Map([[fireHeadKey("strong", NIGHT, "rt1"), { maxFireSeq: 1, anchorAt: cancelledAt, counted: 1, lastCountedAt: cancelledAt }]]);
    expect(countFromFireAt(weak, [strong], history, NIGHT, "rt1", 100)).toBe(cancelledAt);
    const open = openFireHeads([strong, weak], [fire({ id: "x", rule_id: "strong", applied_at: cancelledAt })], new Set(["x"]));
    expect(countFromFireAt(weak, [strong], open, NIGHT, "rt1", 100)).toBeNull();
  });
});

describe("where a pickup condition's window opens on a cell", () => {
  const baseline = "2026-07-13T12:00:00.000Z";

  it("is a whole window back, or the fire counted from when that is later", () => {
    expect(pickupWindowOpensAt(baseline, null, undefined)).toBe(baseline);
    expect(pickupWindowOpensAt(baseline, "2026-07-12T12:00:00.000Z", undefined)).toBe(baseline);
    expect(pickupWindowOpensAt(baseline, "2026-07-15T08:00:00.000Z", undefined)).toBe("2026-07-15T08:00:00.000Z");
  });

  it("ignores a fire made before the open manual price, and means nothing without a pickup condition", () => {
    expect(pickupWindowOpensAt(baseline, "2026-07-15T08:00:00.000Z", { set_at: "2026-07-16T09:00:00.000Z" })).toBe(baseline);
    expect(pickupWindowOpensAt(baseline, "2026-07-17T08:00:00.000Z", { set_at: "2026-07-16T09:00:00.000Z" })).toBe("2026-07-17T08:00:00.000Z");
    expect(pickupWindowOpensAt(null, "2026-07-15T08:00:00.000Z", undefined)).toBeNull();
  });

  it("is judged on a shorter stretch only for \"more than\" 0 or more", () => {
    const pickup = (op: "gt" | "lt", threshold: number) =>
      makeRule({ condition: { pickup_operator: op, pickup_threshold: threshold, pickup_window_days: 7 } });
    expect(pickupJudgesShortStretch(pickup("gt", 4))).toBe(true);
    expect(pickupJudgesShortStretch(pickup("gt", 0))).toBe(true);
    expect(pickupJudgesShortStretch(pickup("gt", -2))).toBe(false);
    expect(pickupJudgesShortStretch(pickup("lt", 3))).toBe(false);
    expect(pickupJudgesShortStretch(makeRule({ condition: { booking_speed_operator: "at_least" } }))).toBe(false);
  });
});

describe("which conditions cancellations can make false (cancellableParts)", () => {
  const parts = (condition: EngineRule["condition"], direction: "increase" | "decrease" = "increase") =>
    cancellableParts(makeRule({ condition, action_direction: direction }));

  it("judges the bars bookings must stay above: occupancy and pickup more than, a pace of at least", () => {
    expect(parts({ occupancy_operator: "gt", occupancy_threshold: 0.7 })).toEqual({ occupancy: true, pickup: false, bookingSpeed: false });
    expect(parts({ pickup_operator: "gt", pickup_threshold: 4, pickup_window_days: 7 })).toEqual({
      occupancy: false,
      pickup: true,
      bookingSpeed: false,
    });
    expect(parts({ booking_speed_operator: "at_least", booking_speed_level: "faster" })).toEqual({
      occupancy: false,
      pickup: false,
      bookingSpeed: true,
    });
  });

  it("leaves what cancellations only make truer: less than, at most, days before arrival", () => {
    const none = { occupancy: false, pickup: false, bookingSpeed: false };
    expect(parts({ occupancy_operator: "lt", occupancy_threshold: 0.3 }, "decrease")).toEqual(none);
    expect(parts({ pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 7 }, "decrease")).toEqual(none);
    expect(parts({ booking_speed_operator: "at_most", booking_speed_level: "much_slower" }, "decrease")).toEqual(none);
    expect(parts({ dta_operator: "lt", dta_threshold_days: 14 })).toEqual(none);
  });

  it("an exact pace counts for a raise, which slower undoes, but not for a cut, which slower still keeps", () => {
    expect(parts({ booking_speed_operator: "is", booking_speed_level: "faster" }).bookingSpeed).toBe(true);
    expect(parts({ booking_speed_operator: "is", booking_speed_level: "slower" }, "decrease").bookingSpeed).toBe(false);
  });

  it("works the same way for a raise and a cut on the same bars", () => {
    const mixed = { occupancy_operator: "gt" as const, occupancy_threshold: 0.2, booking_speed_operator: "at_most" as const, booking_speed_level: "slower" };
    expect(parts(mixed, "decrease")).toEqual({ occupancy: true, pickup: false, bookingSpeed: false });
    expect(parts(mixed, "increase")).toEqual({ occupancy: true, pickup: false, bookingSpeed: false });
  });
});

describe("the fire a rule would make", () => {
  it("numbers the fire above the cell's highest, and freezes the booking speed window", () => {
    const rule = makeRule({
      condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7 },
      signal_room_type_ids: ["rt2", "rt1"],
    });
    const c = candidateFor({
      rule,
      metrics: {
        ...baseMetrics,
        signal_booked_units_now: 16,
        signal_booked_revenue_now: 3200,
        booking_speed: { speed: "faster", rank: 1, label: "Faster Than Normal", recent: 9, expected: 5.125, window_days: 7, method: "comparable" },
      },
      stayDate: "2026-07-15",
      roomTypeId: "rt1",
      now: "2026-07-01T12:00:00.000Z",
      localDate: "2026-07-01",
      baselineTs: null,
      head: { maxFireSeq: 2, anchorAt: null, counted: 0, lastCountedAt: null },
    });
    expect(c.fire_seq).toBe(3);
    expect(c.window_from).toBe("2026-06-25");
    expect(c.window_to).toBe("2026-07-01");
    expect(c.window_bookings_at_fire).toBe(9);
    expect(c.window_expected_at_fire).toBe(5.13);
    expect(c.signal_set_key).toBe("rt1,rt2");
    // No pickup window: the start numbers are now's, and only informational.
    expect(c.signal_booked_units_start).toBe(16);
    expect(c.signal_booked_units_end).toBe(16);
    expect(c.baseline_ts).toBe("2026-06-24T12:00:00.000Z");
    expect(c.cancel_check).toBe("recount");
    // No pickup condition: no arrivals to record.
    expect(c.pickup_units_arrived).toBeNull();
  });

  it("freezes only the days it counted when its last fire cut the window", () => {
    const rule = makeRule({
      condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 30 },
    });
    const c = candidateFor({
      rule,
      metrics: {
        ...baseMetrics,
        booking_speed: {
          speed: "faster", rank: 1, label: "Faster Than Normal", recent: 6, expected: 1.5, window_days: 3, method: "comparable",
          counted_from: "2026-06-29", full_window_days: 30,
        },
      },
      stayDate: "2026-07-15",
      roomTypeId: "rt1",
      now: "2026-07-01T12:00:00.000Z",
      localDate: "2026-07-01",
      baselineTs: null,
      head: { maxFireSeq: 1, anchorAt: "2026-06-28T12:00:00.000Z", counted: 1, lastCountedAt: "2026-06-28T12:00:00.000Z" },
    });
    // The window the cancellation test re-reads is the one it measured.
    expect(c.window_from).toBe("2026-06-29");
    expect(c.window_to).toBe("2026-07-01");
    expect(c.window_bookings_at_fire).toBe(6);
    expect(c.window_expected_at_fire).toBe(1.5);
    expect(c.fire_seq).toBe(2);
  });

  it("a cut rule freezes the complete days it counted, ending the day before the run", () => {
    const rule = makeRule({
      action_direction: "decrease",
      condition: { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30 },
    });
    const c = candidateFor({
      rule,
      metrics: {
        ...baseMetrics,
        booking_speed: {
          speed: "slower", rank: -1, label: "Slower Than Normal", recent: 2, expected: 6, window_days: 6, method: "comparable",
          counted_from: "2026-06-25", full_window_days: 30, counted_through: "2026-06-30",
        },
      },
      stayDate: "2026-07-15",
      roomTypeId: "rt1",
      now: "2026-07-01T00:05:00.000Z",
      localDate: "2026-07-01",
      baselineTs: null,
      head: { maxFireSeq: 1, anchorAt: "2026-06-24T00:05:00.000Z", counted: 1, lastCountedAt: "2026-06-24T00:05:00.000Z" },
    });
    expect(c.window_from).toBe("2026-06-25");
    expect(c.window_to).toBe("2026-06-30");
    expect(c.window_since).toBeNull();
    // Every fire keeps what a cancellation check reads, a cut's too.
    expect(c.cancel_check).toBe("recount");
  });

  it("a pickup rule records what its window opened at", () => {
    const c = candidateFor({
      rule: makeRule(),
      metrics: { ...baseMetrics, signal_booked_units_baseline: 10, signal_booked_units_now: 16, signal_booked_revenue_baseline: 2000, signal_booked_revenue_now: 3200 },
      stayDate: "2026-07-15",
      roomTypeId: "rt1",
      now: "2026-07-01T12:00:00.000Z",
      localDate: "2026-07-01",
      baselineTs: "2026-06-28T12:00:00.000Z",
      head: undefined,
    });
    expect(c.fire_seq).toBe(1);
    expect(c.signal_booked_units_start).toBe(10);
    expect(c.window_from).toBeNull();
    expect(c.cancel_check).toBe("recount");
  });
});

describe("what a pickup count saw come in (arrivalReads, recordArrivals)", () => {
  const booked = (counts: Record<string, Record<string, number>>) =>
    new Map<string, Map<string, BookedCount>>(
      Object.entries(counts).map(([at, byType]) => [
        bookedBeforeKey("2026-07-15", at),
        new Map(Object.entries(byType).map(([rt, units]) => [rt, { units, revenue: units * 150 }])),
      ]),
    );

  it("reads the night where the count opened and at the run's own instant, only for a rule with a pickup condition", () => {
    const pickup = makeCandidate(makeRule());
    const speed = makeCandidate(
      makeRule({ condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7 } }),
    );
    expect(arrivalReads([pickup, speed])).toEqual([
      { stayDate: "2026-07-15", at: "2026-07-12T02:30:00Z" },
      { stayDate: "2026-07-15", at: "2026-07-15T02:30:00Z" },
    ]);
  });

  it("counts what was first seen between the two, on the rule's room types, whatever the snapshot said", () => {
    const c = makeCandidate(makeRule({ signal_room_type_ids: ["rt1", "rt2"] }));
    // The snapshot says 10 then 16; by first sight 9 were there when the
    // count opened (one came in between the snapshot and the instant it
    // stood for) and 16 now, and rt3 isn't measured.
    recordArrivals(
      c,
      booked({ "2026-07-12T02:30:00Z": { rt1: 6, rt2: 3, rt3: 4 }, "2026-07-15T02:30:00Z": { rt1: 10, rt2: 6, rt3: 9 } }),
    );
    expect([c.pickup_units_arrived, c.pickup_revenue_arrived]).toEqual([7, 1050]);
  });

  it("leaves them null when either instant was not read, or the rule counts no pickup", () => {
    const c = makeCandidate(makeRule());
    recordArrivals(c, booked({ "2026-07-12T02:30:00Z": { rt1: 6 } }));
    expect(c.pickup_units_arrived).toBeNull();
    const speed = makeCandidate(
      makeRule({ condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7 } }),
    );
    recordArrivals(speed, booked({ "2026-07-12T02:30:00Z": { rt1: 6 }, "2026-07-15T02:30:00Z": { rt1: 16 } }));
    expect(speed.pickup_units_arrived).toBeNull();
  });
});

describe("insertPickupEvent: two runs recording the same fire (regression)", () => {
  // Two overlapping runs can both read the same fire history and both try to
  // write fire number n+1 for a cell. uq_pickup_event_fire admits one: the
  // other must not count it as its own fire, and must not confuse it with a
  // write that genuinely failed.
  function fakeSupabaseRejectingWith(error: { code: string; message: string } | null) {
    const insert = () => ({
      select: () => ({ single: () => Promise.resolve(error ? { data: null, error } : { data: { id: "e1", rule_id: "r1", applied_at: "2026-07-15T02:30:00Z", fire_seq: 1, action_kind: "percent", action_direction: "increase", action_value: 10 }, error: null }) }),
    });
    return { from: () => ({ insert }) } as unknown as SupabaseClient;
  }

  it("a unique violation naming the fire index is a concurrent fire, not this run's", async () => {
    const result = await insertPickupEvent(
      fakeSupabaseRejectingWith({ code: "23505", message: `duplicate key value violates unique constraint "${FIRE_UNIQUE_INDEX}"` }),
      makeCandidate(makeRule()),
      "hotel-1",
    );
    expect(result.status).toBe("concurrent_fire");
  });

  it("a unique violation on another constraint is a write failure", async () => {
    const result = await insertPickupEvent(
      fakeSupabaseRejectingWith({ code: "23505", message: 'duplicate key value violates unique constraint "uq_something_else"' }),
      makeCandidate(makeRule()),
      "hotel-1",
    );
    expect(result.status).toBe("write_failed");
  });

  it("reports write_failed for any other error", async () => {
    const result = await insertPickupEvent(
      fakeSupabaseRejectingWith({ code: "42501", message: "permission denied" }),
      makeCandidate(makeRule()),
      "hotel-1",
    );
    expect(result.status).toBe("write_failed");
  });

  it("returns the written fire as the effect it applies", async () => {
    const result = await insertPickupEvent(fakeSupabaseRejectingWith(null), makeCandidate(makeRule()), "hotel-1");
    expect(result).toEqual({
      status: "inserted",
      effect: { event_id: "e1", rule_id: "r1", applied_at: "2026-07-15T02:30:00Z", fire_seq: 1, action_kind: "percent", action_direction: "increase", action_value: 10 },
    });
  });

  it("writes every column the fire is judged by later", async () => {
    const { client, tables } = fakeSupabase({ pickup_event: [] });
    const c = makeCandidate(makeRule());
    const out = await insertPickupEvent(
      client,
      {
        ...c,
        fire_seq: 4,
        window_from: "2026-06-25",
        window_to: "2026-07-01",
        window_bookings_at_fire: 9,
        window_expected_at_fire: 5,
        pickup_units_arrived: 6,
        pickup_revenue_arrived: 1200,
      },
      "hotel-1",
    );
    expect(out.status).toBe("inserted");
    expect(tables.pickup_event[0]).toMatchObject({
      fire_seq: 4,
      cancel_check: "recount",
      pickup_units_arrived_at_fire: 6,
      pickup_revenue_arrived_at_fire: 1200,
      window_from: "2026-06-25",
      window_to: "2026-07-01",
      window_bookings_at_fire: 9,
      window_expected_at_fire: 5,
      signal_set_key: "rt1",
      retired_at: null,
    });
  });
});

describe("insertPickupEvent before the undo migration", () => {
  it("writes the fire the way it was written before, and says so once", async () => {
    resetPickupInsertLogOnce();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(
      { pickup_event: [] },
      {
        fault: (call) =>
          call.table === "pickup_event" &&
          call.op === "insert" &&
          (call.payload as Record<string, unknown>).cancel_check === "recount"
            ? { code: "23514", message: 'new row for relation "pickup_event" violates check constraint "pickup_event_cancel_check_chk"' }
            : null,
      },
    );
    const c = makeCandidate(makeRule());
    expect((await insertPickupEvent(client, c, "hotel-1")).status).toBe("inserted");
    expect((await insertPickupEvent(client, { ...c, fire_seq: 2 }, "hotel-1")).status).toBe("inserted");
    expect(tables.pickup_event.map((e) => e.cancel_check)).toEqual(["none", "none"]);
    expect(tables.pickup_event[0]).not.toHaveProperty("pickup_units_arrived_at_fire");
    expect(logged.mock.calls.filter((call) => String(call[0]).includes("undo_on_cancellation"))).toHaveLength(1);
    logged.mockRestore();
  });
});

describe("runPickupPass", () => {
  const basePrices = new Map([[basePriceKey("2026-07-15", "rt1"), 200]]);

  function fakeSupabaseAlwaysFailingWith(code: string) {
    return {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code, message: "insert failed" } }) }) }),
      }),
    } as unknown as SupabaseClient;
  }

  it("puts a real insert failure in write_failures, never among the winners", async () => {
    const rule = makeRule();
    const outcome = await runPickupPass(fakeSupabaseAlwaysFailingWith("57014"), [makeCandidate(rule)], "hotel-1", basePrices);
    expect(outcome.write_failures).toHaveLength(1);
    expect(outcome.write_failures[0].rule.id).toBe(rule.id);
    expect(outcome.winners).toHaveLength(0);
  });

  it("counts a fire another run recorded as neither a winner nor a failure", async () => {
    const outcome = await runPickupPass(
      { from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${FIRE_UNIQUE_INDEX}"` } }) }) }) }) } as unknown as SupabaseClient,
      [makeCandidate(makeRule())],
      "hotel-1",
      basePrices,
    );
    expect(outcome.concurrent_skips).toHaveLength(1);
    expect(outcome.winners).toHaveLength(0);
    expect(outcome.write_failures).toHaveLength(0);
  });

  it("one fire per cell per run: the loser writes nothing and stays a candidate next run", async () => {
    const { client, tables } = fakeSupabase({ pickup_event: [] });
    const strong = makeCandidate(makeRule({ id: "strong", priority: 200 }));
    const weak = makeCandidate(makeRule({ id: "weak", priority: 100 }));
    const outcome = await runPickupPass(client, [weak, strong], "hotel-1", basePrices);
    expect(outcome.winners.map((w) => w.candidate.rule.id)).toEqual(["strong"]);
    expect(outcome.losers.map((l) => l.rule.id)).toEqual(["weak"]);
    expect(tables.pickup_event).toHaveLength(1);
  });

  it("a stronger rule still waiting on the cell, matching again on what it counts itself, holds a weaker rule its way: nothing fires", async () => {
    const { client, tables } = fakeSupabase({ pickup_event: [] });
    const weak = makeCandidate(makeRule({ id: "weak", priority: 100 }));
    const waiting = makeCandidate(makeRule({ id: "strong", priority: 200 }));
    const outcome = await runPickupPass(client, [weak], "hotel-1", basePrices, [{ candidate: waiting, against: "same_way" }]);
    expect(outcome.winners).toHaveLength(0);
    expect(outcome.held.map((h) => [h.candidate.rule.id, h.holder.rule.id])).toEqual([["weak", "strong"]]);
    expect(outcome.holding.map((h) => h.rule.id)).toEqual(["strong"]);
    expect(tables.pickup_event).toHaveLength(0);
  });

  it("a stronger waiting rule matching only over its whole window doesn't hold a weaker rule its way, which counts from its change anyway", async () => {
    // Jake, 2026-09-24: 10 at once raise the rule for 10; 5 more raise the
    // rule for 5 on those 5, though the rule for 10 still waits and its own
    // window still holds all 15.
    const { client } = fakeSupabase({ pickup_event: [] });
    const weak = makeCandidate(makeRule({ id: "weak", priority: 100 }));
    const waiting = makeCandidate(makeRule({ id: "strong", priority: 200 }));
    const outcome = await runPickupPass(client, [weak], "hotel-1", basePrices, [{ candidate: waiting, against: "other_way" }]);
    expect(outcome.winners.map((w) => w.candidate.rule.id)).toEqual(["weak"]);
    expect(outcome.held).toHaveLength(0);
  });

  it("a stronger waiting rule holds a rule moving the price the other way on its whole window, and never on what it counts itself", async () => {
    const cut = makeCandidate(makeRule({ id: "cut", action_direction: "decrease", action_value: 5 }));
    const raise = makeCandidate(makeRule({ id: "raise", action_value: 20 }));
    const whole = await runPickupPass(fakeSupabase({ pickup_event: [] }).client, [cut], "hotel-1", basePrices, [
      { candidate: raise, against: "other_way" },
    ]);
    expect(whole.winners).toHaveLength(0);
    expect(whole.held.map((h) => [h.candidate.rule.id, h.holder.rule.id])).toEqual([["cut", "raise"]]);
    const own = await runPickupPass(fakeSupabase({ pickup_event: [] }).client, [cut], "hotel-1", basePrices, [
      { candidate: raise, against: "same_way" },
    ]);
    expect(own.winners.map((w) => w.candidate.rule.id)).toEqual(["cut"]);
  });

  it("a stronger rule fires while a weaker one waits", async () => {
    const { client } = fakeSupabase({ pickup_event: [] });
    const strong = makeCandidate(makeRule({ id: "strong", priority: 200 }));
    const waiting = makeCandidate(makeRule({ id: "weak", priority: 100 }));
    const outcome = await runPickupPass(client, [strong], "hotel-1", basePrices, [
      { candidate: waiting, against: "same_way" },
      { candidate: waiting, against: "other_way" },
    ]);
    expect(outcome.winners.map((w) => w.candidate.rule.id)).toEqual(["strong"]);
    expect(outcome.held).toHaveLength(0);
  });

  it("names the strongest of several waiting rules that hold the cell", async () => {
    const { client } = fakeSupabase({ pickup_event: [] });
    const weak = makeCandidate(makeRule({ id: "weak", action_value: 5 }));
    const outcome = await runPickupPass(client, [weak], "hotel-1", basePrices, [
      { candidate: makeCandidate(makeRule({ id: "mid", action_value: 10 })), against: "same_way" },
      { candidate: makeCandidate(makeRule({ id: "top", action_value: 20 })), against: "same_way" },
    ]);
    expect(outcome.holding.map((h) => h.rule.id)).toEqual(["top"]);
  });

  it("a cell with only waiting rules is left alone", async () => {
    const { client, calls } = fakeSupabase({ pickup_event: [] });
    const outcome = await runPickupPass(client, [], "hotel-1", basePrices, [{ candidate: makeCandidate(makeRule()), against: "same_way" }]);
    expect(outcome).toMatchObject({ winners: [], held: [], holding: [] });
    expect(calls).toHaveLength(0);
  });
});
