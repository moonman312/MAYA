/**
 * A pickup count that opened at the rule's own last raise or cut, or a
 * stronger rule's newer one, rather than at the start of the rule's window
 * (pickupWindowOpensAt in engine/pickup.ts), is described as what it is:
 * what came in since that change, not over the window's days. The change log reads it off the audit row
 * (pickup_counted_since on the winning candidate's metrics), the owner
 * alert off the latest fire's window (pickup_window_days left empty).
 */
import { describe, expect, it } from "vitest";
import { describeConditions } from "./changelog-narrative";
import { buildApplications, type ChangelogLookups } from "./changelog-route-helpers";
import { nightWhy, type AlertNightRow } from "./rule-alerts";
import type { EvaluationAuditDetails, RuleCondition } from "@/types/domain";

const pickup: RuleCondition = { pickup_operator: "gt", pickup_threshold: 4, pickup_window_days: 7, pickup_metric: "room_nights" };

function auditDetails(metrics: Record<string, unknown>): EvaluationAuditDetails {
  return {
    matched_ladder_rules: [],
    pickup_candidates: [{ rule_id: "rule-2", outcome: "won", event_id: "evt-9", metrics, tie_break_trace: ["winner"] }],
    active_ladder_effects: [],
    active_pickup_effects: [{ event_id: "evt-9", rule_id: "rule-2", delta: "+12%" }],
    application_order: ["pickup:evt-9"],
    pre_clamp_price: "0.00",
    clamped_by: "none",
  } as EvaluationAuditDetails;
}

const lookups: ChangelogLookups = {
  roomTypeNames: new Map([["rt-1", "Deluxe King"]]),
  rules: new Map([
    [
      "rule-2",
      { name: "Pickup surge", action_type: "percent" as const, action_direction: "increase" as const, action_value: 12, is_pickup_rule: true },
    ],
  ]),
  conditions: new Map([["rule-2", pickup]]),
  currencySymbol: "$",
};

describe("the change log on a pickup count that started at its own or a stronger rule's last change", () => {
  it("carries the change it counted from off the audit row, and only when there was one", () => {
    const since = "2026-09-17T12:00:00.000Z";
    const cut = buildApplications(auditDetails({ dta: 20, net_pickup_units: 5, pickup_counted_since: since }), lookups);
    expect(cut[0].metrics).toMatchObject({ pickup_units: 5, pickup_counted_since: since });
    const whole = buildApplications(auditDetails({ dta: 20, net_pickup_units: 5 }), lookups);
    expect(whole[0].metrics).not.toHaveProperty("pickup_counted_since");
  });

  it("says since this rule or a stronger one last raised or cut the night, not the window's days", () => {
    const metrics = { pickup_units: 5, pickup_counted_since: "2026-09-17T12:00:00.000Z" };
    expect(describeConditions(pickup, metrics, null, "increase")).toEqual([
      "5 bookings arrived since this rule or a stronger one last raised this night, past the 4-booking mark you set.",
    ]);
    expect(
      describeConditions({ ...pickup, pickup_operator: "lt", pickup_threshold: 2 }, { ...metrics, pickup_units: 0 }, null, "decrease"),
    ).toEqual(["0 bookings arrived since this rule or a stronger one last cut this night, under the 2-booking mark you set."]);
    expect(describeConditions(pickup, { pickup_counted_since: metrics.pickup_counted_since }, ["Standard"], "increase")).toEqual([
      "Standard bookings since this rule or a stronger one last raised this night came in past the 4-booking mark you set.",
    ]);
    // A count over the whole window reads as it always has.
    expect(describeConditions(pickup, { pickup_units: 5 }, null, "increase")).toEqual([
      "5 bookings arrived in the last 7 days, past the 4-booking mark you set.",
    ]);
  });
});

describe("the owner alert on a pickup count that started at its own or a stronger rule's last change", () => {
  const night = (o: Partial<AlertNightRow> = {}): AlertNightRow => ({
    alert_id: "a1",
    rule_id: "r1",
    stay_date: "2026-10-06",
    fire_count: 3,
    last_fire_at: "2026-09-18T12:00:00.000Z",
    window_days: null,
    window_bookings: null,
    window_expected: null,
    pickup_metric: "room_nights",
    pickup_threshold: 3,
    pickup_window_days: null,
    pickup_net: 6,
    room_types: [],
    ...o,
  });

  it("says since it or a stronger rule last raised or cut the night when no window's days were counted", () => {
    expect(nightWhy(night(), "$", null, "increase")).toEqual([
      "Pickup since it or a stronger rule last raised this night came to 6 room nights, against the 3 you set.",
    ]);
    expect(nightWhy(night({ pickup_net: 0, pickup_threshold: 1 }), "$", null, "decrease")).toEqual([
      "Pickup since it or a stronger rule last cut this night came to 0 room nights, against the 1 you set.",
    ]);
  });

  it("names the window's days when the count was the whole window, as before", () => {
    expect(nightWhy(night({ pickup_window_days: 7 }), "$", null, "increase")).toEqual([
      "Pickup over the last 7 days came to 6 room nights, against the 3 you set.",
    ]);
  });
});
