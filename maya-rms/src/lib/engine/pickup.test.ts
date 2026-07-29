import { describe, expect, it } from "vitest";
import { basePriceKey, insertPickupEvent, pickupTieBreakTrace, selectPickupWinner } from "./pickup";
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
    signal_booked_units_start: 10,
    signal_booked_units_end: 16,
    signal_booked_revenue_start: 2000,
    signal_booked_revenue_end: 3200,
  };
}

describe("pickup competition (§7.3, §15.5)", () => {
  it("single candidate wins unopposed", () => {
    const c = makeCandidate(makeRule());
    const winner = selectPickupWinner([c], new Map());
    expect(winner).toBe(c);
  });

  it("higher priority wins (step 1)", () => {
    const ruleA = makeRule({ id: "rA", priority: 100 });
    const ruleB = makeRule({ id: "rB", priority: 200 });
    const cA = makeCandidate(ruleA);
    const cB = makeCandidate(ruleB);
    const winner = selectPickupWinner([cA, cB], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("more specific rule wins on priority tie (step 2)", () => {
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

  it("stricter pickup threshold wins on specificity tie (step 3, gt)", () => {
    const ruleA = makeRule({ id: "rA", condition: { ...makeRule().condition, pickup_threshold: 5, pickup_operator: "gt" } });
    const ruleB = makeRule({ id: "rB", condition: { ...makeRule().condition, pickup_threshold: 8, pickup_operator: "gt" } });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("stricter pickup threshold wins on specificity tie (step 3, lt)", () => {
    const ruleA = makeRule({ id: "rA", condition: { ...makeRule().condition, pickup_threshold: 5, pickup_operator: "lt" } });
    const ruleB = makeRule({ id: "rB", condition: { ...makeRule().condition, pickup_threshold: 3, pickup_operator: "lt" } });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("larger adjustment value wins (step 4)", () => {
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
      const winner = makeCandidate(fast, "rt1", sd);
      const loser = makeCandidate(slow, "rt1", sd);
      const trace = pickupTieBreakTrace(winner, loser, basePrices);
      const joined = trace.join(" | ");
      expect(joined).not.toMatch(/pickup_threshold\((gt|lt)\):/);
      expect(joined).toContain("not comparable");
    });
  });
});

describe("insertPickupEvent: concurrent runs racing the same cell (regression)", () => {
  // Two overlapping evaluation runs can both read the same stale baseline
  // and both decide to insert an active event for the same (rule, stay
  // date, room type) — uq_pickup_event_active_per_rule_stay_room is the DB
  // guard against that. This pins how insertPickupEvent must respond when
  // it loses that race: as success, not failure, since the desired state
  // (one active event for this cell) already exists via the other run.
  function fakeSupabaseRejectingWith(code: string | null) {
    return {
      from: () => ({
        insert: () =>
          Promise.resolve(
            code ? { error: { code, message: "duplicate key value violates unique constraint" } } : { error: null },
          ),
      }),
    } as unknown as SupabaseClient;
  }

  it("treats a unique-violation (23505) as success — a concurrent run already won", async () => {
    const rule = makeRule();
    const candidate = makeCandidate(rule);
    const ok = await insertPickupEvent(fakeSupabaseRejectingWith("23505"), candidate, "hotel-1");
    expect(ok).toBe(true);
  });

  it("still reports failure for any other error", async () => {
    const rule = makeRule();
    const candidate = makeCandidate(rule);
    const ok = await insertPickupEvent(fakeSupabaseRejectingWith("42501"), candidate, "hotel-1");
    expect(ok).toBe(false);
  });

  it("reports success on a clean insert with no error", async () => {
    const rule = makeRule();
    const candidate = makeCandidate(rule);
    const ok = await insertPickupEvent(fakeSupabaseRejectingWith(null), candidate, "hotel-1");
    expect(ok).toBe(true);
  });
});
