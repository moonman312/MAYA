/** A property's plan, billing status, rooms and pricing mode in words, with no money. */
import { describe, expect, it } from "vitest";
import { billingStatusWords, modeWords, planWords, roomsOf } from "./hotel-words";

const base = { billing_status: null, cancel_at_period_end: null, plan_kind: null, billing_interval: null } as const;

describe("hotel words", () => {
  it("says the billing status plainly, and when it ends at the period's end", () => {
    expect(billingStatusWords(base)).toBe("No subscription");
    expect(billingStatusWords({ ...base, billing_status: "trialing" })).toBe("Trial");
    expect(billingStatusWords({ ...base, billing_status: "past_due" })).toBe("Past due");
    expect(billingStatusWords({ ...base, billing_status: "active", cancel_at_period_end: true })).toBe("Active, ends at period end");
    expect(billingStatusWords({ ...base, billing_status: "something_new" })).toBe("something new");
  });

  it("names the plan", () => {
    expect(planWords(base)).toBe("No plan");
    expect(planWords({ ...base, plan_kind: "internal" })).toBe("Internal");
    expect(planWords({ ...base, plan_kind: "stripe", billing_interval: "month", billing_status: "active" })).toBe("Monthly");
    expect(planWords({ ...base, plan_kind: "stripe", billing_interval: "year", billing_status: "active" })).toBe("Annual");
  });

  it("gives the rooms billed, else the rooms the PMS counts", () => {
    expect(roomsOf({ billed_rooms: 12, measured_rooms: 14 })).toBe(12);
    expect(roomsOf({ billed_rooms: null, measured_rooms: 14 })).toBe(14);
    expect(roomsOf({})).toBeNull();
  });

  it("says Live or Simulation, and nothing before the migration", () => {
    expect(modeWords({ simulation_mode: false })).toBe("Live");
    expect(modeWords({ simulation_mode: true })).toBe("Simulation");
    expect(modeWords({})).toBeNull();
  });
});
