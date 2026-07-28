import { describe, expect, it } from "vitest";
import {
  type AuditChangeRow,
  type ChangelogLookups,
  buildApplications,
  buildCyclesFromAudit,
  buildEntry,
  currencySymbolFor,
  groupAuditRuns,
  isChangeRow,
} from "./changelog-route-helpers";
import type { EvaluationAuditDetails } from "@/types/domain";

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

function row(o: Partial<AuditChangeRow> = {}): AuditChangeRow {
  return {
    evaluation_run_id: "run-1",
    stay_date: "2026-08-01",
    room_type_id: "rt-1",
    evaluated_at: "2026-07-28T10:00:00Z",
    base_price: 200,
    final_price: 220,
    pre_clamp_price: 220,
    floor_price: 100,
    ceiling_price: 400,
    details: details({
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
    }),
    ...o,
  };
}

function lookups(o: Partial<ChangelogLookups> = {}): ChangelogLookups {
  return {
    roomTypeNames: new Map([["rt-1", "Deluxe King"]]),
    rules: new Map([
      [
        "rule-1",
        {
          name: "Busy-day bump",
          action_type: "percent" as const,
          action_direction: "increase" as const,
          action_value: 10,
          is_pickup_rule: false,
        },
      ],
      [
        "rule-2",
        {
          name: "Demand-spike catcher",
          action_type: "percent" as const,
          action_direction: "increase" as const,
          action_value: 12,
          is_pickup_rule: true,
        },
      ],
    ]),
    conditions: new Map([
      ["rule-1", { occupancy_operator: "gt" as const, occupancy_threshold: 0.7 }],
    ]),
    currencySymbol: "$",
    ...o,
  };
}

describe("currencySymbolFor", () => {
  it("maps known codes and prefixes unknown ones", () => {
    expect(currencySymbolFor("USD")).toBe("$");
    expect(currencySymbolFor("EUR")).toBe("€");
    expect(currencySymbolFor("GBP")).toBe("£");
    expect(currencySymbolFor("CHF")).toBe("CHF ");
    expect(currencySymbolFor(null)).toBe("$");
  });
});

describe("groupAuditRuns", () => {
  it("groups by run, stamps the max evaluated_at, and sorts newest first", () => {
    const runs = groupAuditRuns([
      row({ evaluation_run_id: "a", evaluated_at: "2026-07-28T10:00:00Z" }),
      row({ evaluation_run_id: "b", evaluated_at: "2026-07-28T11:00:00Z" }),
      row({ evaluation_run_id: "a", evaluated_at: "2026-07-28T10:00:05Z" }),
    ]);
    expect(runs.map((r) => r.evaluation_run_id)).toEqual(["b", "a"]);
    expect(runs[1].timestamp).toBe("2026-07-28T10:00:05Z");
    expect(runs[1].rows).toHaveLength(2);
  });

  it("keeps only the 10 most recent runs", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({
        evaluation_run_id: `run-${i}`,
        evaluated_at: `2026-07-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const runs = groupAuditRuns(rows);
    expect(runs).toHaveLength(10);
    expect(runs[0].evaluation_run_id).toBe("run-11");
    expect(runs[9].evaluation_run_id).toBe("run-2");
  });
});

describe("isChangeRow", () => {
  it("flags price movement of at least a cent", () => {
    expect(isChangeRow(row({ base_price: 200, final_price: 200.01, details: details() }))).toBe(true);
    expect(isChangeRow(row({ base_price: 200, final_price: 200.004, details: details() }))).toBe(false);
  });

  it("flags unchanged prices when rules still applied (e.g. clamped back)", () => {
    expect(
      isChangeRow(
        row({
          base_price: 200,
          final_price: 200,
          details: details({ application_order: ["ladder:rule-1"] }),
        }),
      ),
    ).toBe(true);
  });
});

describe("buildApplications", () => {
  it("prefers matched_ladder_rules for action and observed metrics", () => {
    const apps = buildApplications(row().details, lookups());
    expect(apps).toHaveLength(1);
    expect(apps[0].rule_name).toBe("Busy-day bump");
    expect(apps[0].action).toEqual({ kind: "percent", direction: "increase", value: 10 });
    expect(apps[0].metrics).toEqual({ occupancy: 0.82, dta: 12, pickup_units: null });
    expect(apps[0].condition).toEqual({ occupancy_operator: "gt", occupancy_threshold: 0.7 });
    expect(apps[0].is_pickup).toBe(false);
  });

  it("maps pickup event ids to rules and marks them as pickups", () => {
    const d = details({
      active_pickup_effects: [{ event_id: "evt-9", rule_id: "rule-2", delta: "+12%" }],
      pickup_candidates: [
        {
          rule_id: "rule-2",
          outcome: "won",
          metrics: { occupancy: 0.9, dta: 3, net_pickup_units: 9 },
          tie_break_trace: ["winner"],
        },
      ],
      application_order: ["pickup:evt-9"],
    });
    const apps = buildApplications(d, lookups());
    expect(apps).toHaveLength(1);
    expect(apps[0].rule_name).toBe("Demand-spike catcher");
    expect(apps[0].is_pickup).toBe(true);
    expect(apps[0].action).toEqual({ kind: "percent", direction: "increase", value: 12 });
    expect(apps[0].metrics).toEqual({ occupancy: 0.9, dta: 3, pickup_units: 9 });
  });

  it("falls back to the rule lookup with null metrics for carried-over effects", () => {
    const d = details({
      active_ladder_effects: [{ rule_id: "rule-1", delta: "+10%" }],
      application_order: ["ladder:rule-1"],
    });
    const apps = buildApplications(d, lookups());
    expect(apps).toHaveLength(1);
    expect(apps[0].action).toEqual({ kind: "percent", direction: "increase", value: 10 });
    expect(apps[0].metrics).toBeNull();
  });

  it("preserves application order across ladder and pickup steps", () => {
    const d = details({
      matched_ladder_rules: [
        {
          rule_id: "rule-1",
          rule_version: 1,
          transition: "activate",
          action: { kind: "percent", direction: "increase", value: 10 },
          metrics: { occupancy: 0.82 },
        },
      ],
      active_ladder_effects: [{ rule_id: "rule-1", delta: "+10%" }],
      active_pickup_effects: [{ event_id: "evt-9", rule_id: "rule-2", delta: "+12%" }],
      application_order: ["ladder:rule-1", "pickup:evt-9"],
    });
    const apps = buildApplications(d, lookups());
    expect(apps.map((a) => a.rule_name)).toEqual(["Busy-day bump", "Demand-spike catcher"]);
    expect(apps.map((a) => a.is_pickup)).toEqual([false, true]);
  });

  it("skips steps it cannot resolve to an action", () => {
    const d = details({
      active_ladder_effects: [{ rule_id: "rule-gone", delta: "+5%" }],
      application_order: ["ladder:rule-gone", "pickup:evt-unknown"],
    });
    expect(buildApplications(d, lookups())).toEqual([]);
  });
});

describe("buildEntry", () => {
  it("assembles a narrated entry from an audit row", () => {
    const entry = buildEntry(row(), lookups());
    expect(entry.room_type).toBe("Deluxe King");
    expect(entry.rule_name).toBe("Busy-day bump");
    expect(entry.original_rate).toBe(200);
    expect(entry.new_rate).toBe(220);
    expect(entry.change_pct).toBe(10);
    expect(entry.occupancy_pct).toBe(82);
    expect(entry.stay_date).toBe("2026-08-01");
    expect(entry.narrative).toEqual([
      '"Busy-day bump" kicked in because occupancy (82%) was above 70%, which raised the rate 10%, from $200.00 to $220.00.',
    ]);
    expect(entry.description).toBe(entry.narrative!.join(" "));
  });

  it("labels unknown room types and rounds change_pct to one decimal", () => {
    const entry = buildEntry(
      row({
        room_type_id: "rt-mystery",
        base_price: 300,
        final_price: 337,
        details: details(),
      }),
      lookups(),
    );
    expect(entry.room_type).toBe("Unknown room type");
    expect(entry.rule_name).toBe("Price update");
    expect(entry.change_pct).toBe(12.3);
    expect(entry.occupancy_pct).toBe(0);
    expect(entry.narrative).toEqual(["The rate moved from $300.00 to $337.00."]);
  });

  it("narrates ceiling clamps using the row's ceiling", () => {
    const entry = buildEntry(
      row({
        base_price: 380,
        final_price: 400,
        pre_clamp_price: 418,
        details: details({
          matched_ladder_rules: [
            {
              rule_id: "rule-1",
              rule_version: 1,
              transition: "activate",
              action: { kind: "percent", direction: "increase", value: 10 },
              metrics: { occupancy: 0.82 },
            },
          ],
          active_ladder_effects: [{ rule_id: "rule-1", delta: "+10%" }],
          application_order: ["ladder:rule-1"],
          clamped_by: "ceiling",
        }),
      }),
      lookups(),
    );
    expect(entry.narrative![1]).toBe(
      "That landed above the $400.00 ceiling for Deluxe King, so the final rate was capped at $400.00.",
    );
  });
});

describe("buildCyclesFromAudit", () => {
  it("numbers cycles newest-highest and keeps changeless runs", () => {
    const cycles = buildCyclesFromAudit(
      [
        row({
          evaluation_run_id: "old",
          evaluated_at: "2026-07-28T09:00:00Z",
          base_price: 200,
          final_price: 200,
          details: details(),
        }),
        row({ evaluation_run_id: "new", evaluated_at: "2026-07-28T10:00:00Z" }),
      ],
      lookups(),
    );
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ cycle: 2, timestamp: "2026-07-28T10:00:00Z", has_changes: true });
    expect(cycles[0].changes).toHaveLength(1);
    expect(cycles[1]).toMatchObject({ cycle: 1, has_changes: false, changes: [] });
  });

  it("sorts a cycle's entries by absolute change and caps at 40", () => {
    const rows: AuditChangeRow[] = [
      row({ room_type_id: "rt-small", base_price: 200, final_price: 210, details: details() }),
      row({ base_price: 200, final_price: 160, details: details() }),
      ...Array.from({ length: 45 }, (_, i) =>
        row({
          room_type_id: `rt-bulk-${i}`,
          base_price: 200,
          final_price: 202,
          details: details(),
        }),
      ),
    ];
    const cycles = buildCyclesFromAudit(rows, lookups());
    expect(cycles).toHaveLength(1);
    expect(cycles[0].changes).toHaveLength(40);
    expect(cycles[0].changes[0].change_pct).toBe(-20);
    expect(cycles[0].changes[1].change_pct).toBe(5);
  });
});
