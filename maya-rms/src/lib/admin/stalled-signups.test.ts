/**
 * The triage rules, which are the only part of this feature with an opinion.
 *
 * What must not drift: a signup that has been charged twice for a product it has
 * never used outranks one that is stalled on a free trial, and a signup whose
 * card is also dead is never chased about setup. Get either wrong and the list
 * sends the wrong email to the wrong person.
 */
import { describe, expect, it } from "vitest";
import {
  isReachable,
  monthlyCents,
  rollUp,
  severityOf,
  spentCents,
  stuckFor,
  summarize,
  triage,
  type StalledSignupRow,
} from "./stalled-signups";

function row(o: Partial<StalledSignupRow> = {}): StalledSignupRow {
  return {
    hotel_id: "hotel-1",
    hotel_name: "The Test Inn",
    stage: "no_pms",
    stuck_since: "2026-07-01T00:00:00Z",
    stuck_hours: 24 * 29,
    admin_email: "owner@example.com",
    admin_name: "Sam Owner",
    email_confirmed: true,
    last_sign_in_at: "2026-07-01T00:00:00Z",
    status: "active",
    billing_interval: "month",
    billed_rooms: 40,
    trial_end: null,
    current_period_end: "2026-08-01T00:00:00Z",
    periods_billed: 1,
    card_verify_failed_at: null,
    card_verify_last_code: null,
    signup_code: "MHSFOUNDER",
    pms_type: null,
    pms_status: null,
    import_status: null,
    import_phase: null,
    import_error: null,
    rooms_measured: null,
    signup_abandoned_at: null,
    signup_abandoned_note: null,
    created_at: "2026-07-01T00:00:00Z",
    ...o,
  };
}

describe("severityOf", () => {
  it("calls it burning once a second payment has been taken", () => {
    expect(severityOf(row({ periods_billed: 2 }))).toBe("burning");
    expect(severityOf(row({ periods_billed: 9 }))).toBe("burning");
  });

  it("holds at warming after only the first", () => {
    expect(severityOf(row({ periods_billed: 1 }))).toBe("warming");
  });

  it("is only a nudge while the trial is still running", () => {
    // Nothing has been collected, so there is nothing to give back — this is what
    // the invoice.upcoming email exists to catch before it ever reaches this list.
    expect(severityOf(row({ status: "trialing", periods_billed: 0 }))).toBe("nudge");
  });

  it("is only a nudge when checkout never completed", () => {
    // Stripe took nothing, so no amount of time makes this a money problem.
    expect(
      severityOf(row({ stage: "payment_incomplete", status: "incomplete", periods_billed: 4 })),
    ).toBe("nudge");
  });

  it("puts a dead card above everything, even a long-paying one", () => {
    const dead = row({ periods_billed: 6, card_verify_failed_at: "2026-07-10T00:00:00Z" });
    expect(severityOf(dead)).toBe("dead_card");
    // And the advice changes with it: chasing setup is the wrong conversation.
    expect(triage(dead).action).toMatch(/card/i);
  });
});

describe("triage", () => {
  it("names the step in words an admin can act on", () => {
    expect(triage(row({ stage: "no_pms" })).headline).toBe("Paid, never connected a PMS");
    expect(triage(row({ stage: "import_stuck" })).action).toMatch(/cron/);
  });

  it("does not claim money was taken when none was", () => {
    const trial = triage(row({ status: "trialing", periods_billed: 0, trial_end: "2026-08-05T00:00:00Z" }));
    expect(trial.spent_cents).toBe(0);
  });

  it("prices a 40-room property at its own bracket, not the top one", () => {
    // 40 rooms sits in the $5.00 bracket: 40 × $5.00 = $200.
    expect(monthlyCents(row({ billed_rooms: 40 }))).toBe(20_000);
    expect(spentCents(row({ billed_rooms: 40, periods_billed: 3 }))).toBe(60_000);
  });

  it("divides an annual signup back down so it compares to a monthly one", () => {
    const annual = monthlyCents(row({ billed_rooms: 40, billing_interval: "year" }));
    const monthly = monthlyCents(row({ billed_rooms: 40, billing_interval: "month" }));
    // 10% off for 21+ rooms, so a year is 10% cheaper per month.
    expect(annual).toBeLessThan(monthly);
    expect(annual).toBe(Math.round((monthly * 90) / 100));
  });

  it("treats an unconfirmed address as unreachable", () => {
    expect(isReachable(row({ email_confirmed: false }))).toBe(false);
    expect(isReachable(row({ admin_email: null, email_confirmed: true }))).toBe(false);
    expect(isReachable(row())).toBe(true);
  });
});

describe("rollUp", () => {
  it("counts only collected money as taken", () => {
    const totals = rollUp([
      triage(row({ hotel_id: "a", billed_rooms: 40, periods_billed: 3 })),
      triage(row({ hotel_id: "b", billed_rooms: 40, status: "trialing", periods_billed: 0 })),
    ]);
    expect(totals.count).toBe(2);
    expect(totals.burning).toBe(1);
    // Only the paying one contributes; the trial has been charged nothing.
    expect(totals.spent_cents).toBe(60_000);
    // But both are worth the same per month if they ever get set up.
    expect(totals.monthly_cents).toBe(40_000);
  });

  it("counts who cannot be emailed at all", () => {
    const totals = rollUp([
      triage(row({ hotel_id: "a", email_confirmed: false })),
      triage(row({ hotel_id: "b" })),
    ]);
    expect(totals.unreachable).toBe(1);
  });
});

describe("summarize", () => {
  it("leads with the money once anything has been collected", () => {
    const line = summarize(rollUp([triage(row({ billed_rooms: 40, periods_billed: 3 }))]));
    expect(line).toContain("$600");
    expect(line).toContain("charged at least twice");
  });

  it("says so plainly when nobody is stuck", () => {
    expect(summarize(rollUp([]))).toMatch(/Nobody is stuck/);
  });

  it("does not invent a money figure when nothing was collected", () => {
    const line = summarize(rollUp([triage(row({ status: "trialing", periods_billed: 0 }))]));
    expect(line).not.toContain("$");
  });
});

describe("stuckFor", () => {
  it("switches units as the number gets embarrassing", () => {
    expect(stuckFor(5)).toBe("5h");
    expect(stuckFor(47)).toBe("47h");
    expect(stuckFor(24 * 6)).toBe("6 days");
    expect(stuckFor(24 * 30)).toBe("4 weeks");
    expect(stuckFor(24 * 90)).toBe("3 months");
  });

  it("never reports zero for something that is on the list", () => {
    // Rounding a 20-minute-old row to "0h" would read as a bug in the list.
    expect(stuckFor(0.2)).toBe("1h");
  });
});
