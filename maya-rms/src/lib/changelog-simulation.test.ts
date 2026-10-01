/**
 * The change log's words for each kind of item, in simulation and live
 * (Jake, 2026-09-30): an item recorded while the property was simulating
 * never says a price changed or was sent, and says what would have happened;
 * the label follows the mode at the item's own time, so a simulated run stays
 * simulated once the property is live; and a property whose history MAYA
 * cannot tell reads exactly as the log always did.
 */
import { describe, expect, it } from "vitest";
import {
  type AuditChangeRow,
  type ChangelogLookups,
  type PriorAuditRow,
  buildAlertChoices,
  buildCyclesFromAudit,
  buildCyclesFromRuns,
  buildEntry,
} from "./changelog-route-helpers";
import { modeTimelineFrom } from "./price-mode";
import type { EvaluationAuditDetails } from "@/types/domain";

/** Simulating until Sep 20 10:00 UTC, live after. */
const TIMELINE = modeTimelineFrom([
  { since: "-infinity", simulated: true },
  { since: "2026-09-20T10:00:00Z", simulated: false },
]);
const SIM_AT = "2026-09-18T08:00:00Z";
const LIVE_AT = "2026-09-22T08:00:00Z";

function details(o: Partial<EvaluationAuditDetails> = {}): EvaluationAuditDetails {
  return {
    matched_ladder_rules: [],
    pickup_candidates: [],
    active_ladder_effects: [],
    active_pickup_effects: [],
    application_order: [],
    pre_clamp_price: "0.00",
    clamped_by: "none",
    ...o,
  };
}

const busy = details({
  matched_ladder_rules: [
    {
      rule_id: "rule-1",
      rule_version: 1,
      transition: "activate",
      action: { kind: "percent", direction: "increase", value: 10 },
      metrics: { occupancy: 0.82, dta: 12, net_pickup_units: null },
    },
  ],
  active_ladder_effects: [{ rule_id: "rule-1", delta: "+10%" }],
  application_order: ["ladder:rule-1"],
});

function row(o: Partial<AuditChangeRow> = {}): AuditChangeRow {
  return {
    evaluation_run_id: "run-1",
    stay_date: "2026-11-13",
    room_type_id: "rt-1",
    evaluated_at: SIM_AT,
    base_price: 150,
    final_price: 165,
    pre_clamp_price: 165,
    floor_price: 100,
    ceiling_price: 400,
    details: busy,
    ...o,
  };
}

function lookups(o: Partial<ChangelogLookups> = {}): ChangelogLookups {
  return {
    roomTypeNames: new Map([["rt-1", "Queen"]]),
    rules: new Map([
      ["rule-1", { name: "Busy nights", action_type: "percent" as const, action_direction: "increase" as const, action_value: 10, is_pickup_rule: false }],
      ["rule-2", { name: "Quick pickup", action_type: "percent" as const, action_direction: "increase" as const, action_value: 12, is_pickup_rule: true }],
    ]),
    conditions: new Map([["rule-1", { occupancy_operator: "gt" as const, occupancy_threshold: 0.7 }]]),
    currencySymbol: "$",
    modeTimeline: TIMELINE,
    pmsType: "cloudbeds",
    setterNames: new Map([["u-1", "Sam"]]),
    ...o,
  };
}

/** Every sentence an entry shows: the bold line, the sending line and the narrative. */
const words = (e: ReturnType<typeof buildEntry>) => [e.headline ?? "", e.send_line ?? "", ...(e.narrative ?? [])].join(" ");

/** Wording that would claim a price moved or went out ("would have raised" is fine). */
const CLAIMS = /(?<!would have )\b(raised this night|lowered this night|raised it|lowered it|came off|stopped there|stopped at|That took|The rate moved|set the base rate|Sent to|up to|down to)\b/;

describe("a rule's change", () => {
  it("in simulation, says what would have happened and that nothing was sent", () => {
    const e = buildEntry(row(), lookups());
    expect(e).toMatchObject({
      mode: "simulation",
      headline: "Simulation: the price for Fri Nov 13, Queen would have gone from $150.00 to $165.00.",
      send_line: "Nothing was sent to Cloudbeds.",
      send_state: "simulated",
    });
    expect(e.narrative).toEqual([
      '"Busy nights" would have raised this night 10%, from $150.00 to $165.00.',
      "It was 82% full, past the 70% mark you set.",
    ]);
    expect(words(e)).not.toMatch(CLAIMS);
  });

  it("live, keeps the log's words and leaves the sending line to the ledger", () => {
    const e = buildEntry(row({ evaluated_at: LIVE_AT }), lookups());
    expect(e).toMatchObject({ mode: "live", headline: "Queen · stay 2026-11-13: $150.00 up to $165.00 (+10%)" });
    expect(e.send_line).toBeUndefined();
    expect(e.narrative?.[0]).toBe('"Busy nights" raised this night 10%, from $150.00 to $165.00.');
  });

  it("stays simulated after the property goes live: the label follows the run's own time", () => {
    // The same history, read now that the property is live.
    expect(buildEntry(row({ evaluated_at: SIM_AT }), lookups()).mode).toBe("simulation");
  });

  it("reads as the log always did where the mode is not known", () => {
    const e = buildEntry(row(), lookups({ modeTimeline: [] }));
    expect(e.mode).toBeUndefined();
    expect(e.send_line).toBeUndefined();
    expect(e.headline).toBe("Queen · stay 2026-11-13: $150.00 up to $165.00 (+10%)");
    expect(e.narrative?.[0]).toBe('"Busy nights" raised this night 10%, from $150.00 to $165.00.');
  });

  it("names the property system it would have gone to, or none", () => {
    expect(buildEntry(row(), lookups({ pmsType: "think" })).send_line).toBe("Nothing was sent to Think Reservations.");
    expect(buildEntry(row(), lookups({ pmsType: null })).send_line).toBe("Nothing was sent to your property system.");
  });
});

describe("an event rule firing again on one night", () => {
  const stacked = details({
    active_pickup_effects: [
      { event_id: "evt-1", rule_id: "rule-2", delta: "+12%", applied_at: "2026-09-10T10:00:00Z", fire_seq: 1 },
      { event_id: "evt-2", rule_id: "rule-2", delta: "+12%", applied_at: SIM_AT, fire_seq: 2 },
    ],
    pickup_candidates: [
      { rule_id: "rule-2", outcome: "won", metrics: { net_pickup_units: 9 }, tie_break_trace: ["winner"], event_id: "evt-2", fire_seq: 2 },
    ],
    application_order: ["pickup:evt-1", "pickup:evt-2"],
  });

  it("says it would have raised it again", () => {
    const e = buildEntry(row({ base_price: 200, final_price: 250.88, details: stacked }), lookups());
    expect(e.narrative?.slice(0, 2)).toEqual([
      '"Quick pickup" would have raised this night 12%, from $200.00 to $224.00.',
      'Then "Quick pickup" would have raised it another 12%, from $224.00 to $250.88.',
    ]);
  });
});

describe("a limit stepping in", () => {
  it("says the price would have stopped at the ceiling", () => {
    const e = buildEntry(
      row({ base_price: 150, final_price: 160, pre_clamp_price: 165, ceiling_price: 160, details: { ...busy, clamped_by: "ceiling" } }),
      lookups(),
    );
    expect(e.narrative?.at(-1)).toBe("That would have gone past your $160.00 ceiling for Queen, so it would have stopped there.");
    expect(buildEntry(row({ evaluated_at: LIVE_AT, base_price: 150, final_price: 160, pre_clamp_price: 165, ceiling_price: 160, details: { ...busy, clamped_by: "ceiling" } }), lookups()).narrative?.at(-1)).toBe(
      "That would have gone past your $160.00 ceiling for Queen, so it stopped there.",
    );
  });
});

describe("a change taken off", () => {
  const retired = details({
    retired_pickup_effects: [
      { event_id: "evt-3", rule_id: "rule-2", delta: "+12%", applied_at: "2026-09-10T10:00:00Z", fire_seq: 1, reason: "bookings_cancelled", cancel_check: "either" },
      { event_id: "evt-4", rule_id: "rule-2", delta: "+12%", applied_at: "2026-09-11T10:00:00Z", fire_seq: 2, reason: "manual_price", cancel_check: "none" },
    ],
  });

  it("says it would have come off", () => {
    const e = buildEntry(row({ base_price: 150, final_price: 150, details: retired }), lookups());
    expect(e.narrative?.slice(0, 2)).toEqual([
      'Cancellations meant "Quick pickup" was no longer true, so its 12% raise would have come off.',
      '"Quick pickup" would have stopped applying an earlier 12% raise here: this night\'s price was set by hand.',
    ]);
  });
});

describe("a night put back at its base", () => {
  const prior: PriorAuditRow = { final_price: 165, base_price: 150, application_order: ["ladder:rule-1"], manual: null };
  const atBase = row({ base_price: 150, final_price: 150, pre_clamp_price: 150, details: details() });

  it("in simulation, says it would have gone back", () => {
    const e = buildEntry({ ...atBase, previous: prior }, lookups());
    expect(e.headline).toBe("Simulation: the price for Fri Nov 13, Queen would have gone from $165.00 to $150.00.");
    expect(e.narrative).toEqual([
      '"Busy nights" would have stopped applying an earlier 10% raise here.',
      "That would have taken this night from $165.00 to $150.00.",
    ]);
    expect(words(e)).not.toMatch(CLAIMS);
  });

  it("live, says it went back", () => {
    const e = buildEntry({ ...atBase, evaluated_at: LIVE_AT, previous: prior }, lookups());
    expect(e.narrative?.at(-1)).toBe("That took this night from $165.00 to $150.00.");
  });

  it("with nothing else to say, says the price would have moved", () => {
    const e = buildEntry({ ...atBase, previous: { ...prior, application_order: ["ladder:gone"] } }, lookups());
    expect(e.narrative).toEqual(["The price would have moved from $165.00 to $150.00."]);
  });

  it("calls the property's own rate changing what it is, in either mode", () => {
    const base = { ...prior, final_price: 140, base_price: 140, application_order: [] };
    expect(buildEntry({ ...atBase, previous: base }, lookups()).narrative).toEqual(["The base rate for this night changed from $140.00 to $150.00."]);
  });
});

describe("a price typed by hand", () => {
  const typed = (at: string) =>
    row({
      evaluated_at: at,
      base_price: 160,
      final_price: 160,
      pre_clamp_price: 160,
      details: { ...details(), manual_override: { set_by: "u-1", set_at: at } } as EvaluationAuditDetails,
    });

  it("in simulation, says who typed it, and that it would have been the price", () => {
    const e = buildEntry(typed(SIM_AT), lookups());
    expect(e.headline).toBe("Simulation: the price for Fri Nov 13, Queen would have been $160.00.");
    expect(e.narrative).toEqual(["Sam typed a price of $160.00."]);
    expect(e.send_line).toBe("Nothing was sent to Cloudbeds.");
    expect(words(e)).not.toMatch(CLAIMS);
  });

  it("live, keeps the log's words", () => {
    expect(buildEntry(typed(LIVE_AT), lookups()).narrative).toEqual(["Sam set the base rate to $160.00."]);
  });
});

describe("a run", () => {
  it("carries the mode at its time, from the run log or the audit rows alike (a daily pass included)", () => {
    const runs = buildCyclesFromRuns(
      [
        { evaluation_run_id: "live", timestamp: LIVE_AT, hasChanges: true, topRows: [row({ evaluated_at: LIVE_AT, evaluation_run_id: "live" })] },
        { evaluation_run_id: "sim", timestamp: SIM_AT, hasChanges: true, topRows: [row()] },
      ],
      lookups(),
    );
    expect(runs.map((c) => c.mode)).toEqual(["live", "simulation"]);
    // A daily pass is a run like any other: every one of its changes is worded for its time.
    const pass = buildCyclesFromAudit(
      Array.from({ length: 5 }, (_, i) => row({ evaluation_run_id: "pass", stay_date: `2026-11-1${i}` })),
      lookups(),
    );
    expect(pass[0].mode).toBe("simulation");
    expect(pass[0].changes.every((c) => c.headline?.startsWith("Simulation: the price for ") && c.send_line === "Nothing was sent to Cloudbeds.")).toBe(true);
    expect(buildCyclesFromAudit([row()], lookups({ modeTimeline: [] }))[0]).not.toHaveProperty("mode");
  });
});

describe("an answer to a rule that kept adjusting", () => {
  const answer = (at: string) =>
    buildAlertChoices([{ rule_id: "rule-2", stay_date: "2026-11-13", choice: "stop", at, by: "u-1" }], lookups())[0];

  it("calls what the rule did simulated, when it was", () => {
    expect(answer(SIM_AT)).toMatchObject({
      mode: "simulation",
      title: 'Sam stopped "Quick pickup" on Fri, Nov 13 2026. Its simulated changes so far stay, unless cancellations mean the rule is no longer true.',
    });
    expect(answer(LIVE_AT)).toMatchObject({
      mode: "live",
      title: 'Sam stopped "Quick pickup" on Fri, Nov 13 2026. What it already changed stays, unless cancellations mean the rule is no longer true.',
    });
  });
});

describe("every simulated wording", () => {
  it("uses no em dash", () => {
    const e = buildEntry(row(), lookups());
    expect(words(e)).not.toMatch(/—/);
  });
});
