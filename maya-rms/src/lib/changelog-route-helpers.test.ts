import { describe, expect, it } from "vitest";
import {
  type AuditChangeRow,
  type ChangelogLookups,
  type QuietGap,
  type RunHeartbeat,
  MAX_CANDIDATE_RUNS,
  MAX_CHANGED_RUNS,
  buildAlertChoices,
  buildApplications,
  buildCyclesFromAudit,
  buildEntry,
  buildQuietChecks,
  buildRetirements,
  currencySymbolFor,
  findShownRuns,
  groupAuditRuns,
  inQuietGap,
  isChangeRow,
  isQuietChecks,
  isRuleAlertChoice,
  planQuietGaps,
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

describe("manual price rows", () => {
  // The engine stamps this beside the guide's details shape; it is not on
  // EvaluationAuditDetails itself, so the tests attach it the way the audit
  // table would carry it.
  const withOverride = (o: Partial<EvaluationAuditDetails> = {}, setBy: string | null = "user-1") =>
    ({ ...details(o), manual_override: { set_by: setBy, set_at: "2026-07-28T09:00:00Z" } }) as EvaluationAuditDetails;

  it("isChangeRow keeps an untouched manual price, which would otherwise be invisible", () => {
    expect(isChangeRow(row({ base_price: 250, final_price: 250, details: withOverride() }))).toBe(true);
    expect(isChangeRow(row({ base_price: 250, final_price: 250, details: details() }))).toBe(false);
  });

  it("names the setter and stops there when no rule stacked on the typed number", () => {
    const entry = buildEntry(
      row({ base_price: 250, final_price: 250, details: withOverride() }),
      lookups({ setterNames: new Map([["user-1", "Jake Mooney"]]) }),
    );
    expect(entry.narrative).toEqual(["Jake Mooney set the base rate to $250.00."]);
    expect(entry.description).toBe("Jake Mooney set the base rate to $250.00.");
    expect(entry.rule_name).toBe("Manual price");
    expect(entry.change_pct).toBe(0);
  });

  it("leads with the setter, then the usual rule sentences", () => {
    const entry = buildEntry(
      row({
        base_price: 250,
        final_price: 275,
        details: withOverride({
          matched_ladder_rules: row().details.matched_ladder_rules,
          active_ladder_effects: row().details.active_ladder_effects,
          application_order: ["ladder:rule-1"],
        }),
      }),
      lookups({ setterNames: new Map([["user-1", "Jake Mooney"]]) }),
    );
    expect(entry.narrative).toEqual([
      "Jake Mooney set the base rate to $250.00.",
      '"Busy-day bump" raised this night 10%, from $250.00 to $275.00.',
      "It was 82% full, past the 70% mark you set.",
    ]);
    expect(entry.rule_name).toBe("Busy-day bump");
  });

  it("falls back to 'A manager' when the setter is unknown or gone", () => {
    const unknown = buildEntry(row({ base_price: 250, final_price: 250, details: withOverride() }), lookups());
    expect(unknown.narrative).toEqual(["A manager set the base rate to $250.00."]);

    const gone = buildEntry(
      row({ base_price: 250, final_price: 250, details: withOverride({}, null) }),
      lookups({ setterNames: new Map([["user-1", "Jake Mooney"]]) }),
    );
    expect(gone.narrative).toEqual(["A manager set the base rate to $250.00."]);
  });

  it("uses the hotel's currency symbol", () => {
    const entry = buildEntry(
      row({ base_price: 250, final_price: 250, details: withOverride() }),
      lookups({ currencySymbol: "€" }),
    );
    expect(entry.narrative).toEqual(["A manager set the base rate to €250.00."]);
  });

  it("keeps a clamp sentence after the lead", () => {
    const entry = buildEntry(
      row({
        base_price: 50,
        final_price: 100,
        pre_clamp_price: 50,
        floor_price: 100,
        details: withOverride({ clamped_by: "floor" }),
      }),
      lookups(),
    );
    expect(entry.narrative).toEqual([
      "A manager set the base rate to $50.00.",
      "That would have dropped under your $100.00 floor for Deluxe King, so it stopped there.",
    ]);
  });

  it("says a price changed in the PMS was changed there, naming no one", () => {
    const fromPms = (pms_type: unknown) =>
      ({ ...details(), manual_override: { set_by: null, set_at: "2026-07-28T09:00:00Z", source: "pms", pms_type } }) as EvaluationAuditDetails;
    const entry = buildEntry(row({ base_price: 180, final_price: 180, details: fromPms("cloudbeds") }), lookups());
    expect(entry.narrative).toEqual(["The base rate was changed in Cloudbeds to $180.00."]);
    expect(entry.rule_name).toBe("Changed in Cloudbeds");
    expect(entry.description).not.toContain("—");

    const stacked = buildEntry(
      row({
        base_price: 180,
        final_price: 198,
        details: {
          ...fromPms("think"),
          matched_ladder_rules: row().details.matched_ladder_rules,
          active_ladder_effects: row().details.active_ladder_effects,
          application_order: ["ladder:rule-1"],
        } as EvaluationAuditDetails,
      }),
      lookups(),
    );
    expect(stacked.narrative?.slice(0, 2)).toEqual([
      "The base rate was changed in Think Reservations to $180.00.",
      '"Busy-day bump" raised this night 10%, from $180.00 to $198.00.',
    ]);

    // A comp night, and a row that lost which PMS.
    expect(buildEntry(row({ base_price: 0, final_price: 0, details: fromPms("cloudbeds") }), lookups()).narrative).toEqual([
      "The base rate was changed in Cloudbeds to $0.00.",
    ]);
    expect(buildEntry(row({ base_price: 180, final_price: 180, details: fromPms(null) }), lookups()).rule_name).toBe("Changed in the PMS");
    expect(isChangeRow(row({ base_price: 180, final_price: 180, details: fromPms("cloudbeds") }))).toBe(true);
  });

  it("says a rule on a manual price under the floor stopped at that price, not at the floor", () => {
    const entry = buildEntry(
      row({
        base_price: 50,
        final_price: 50,
        pre_clamp_price: 45,
        floor_price: 100,
        details: withOverride({
          matched_ladder_rules: row().details.matched_ladder_rules,
          active_ladder_effects: row().details.active_ladder_effects,
          application_order: ["ladder:rule-1"],
          clamped_by: "floor",
        }),
      }),
      lookups(),
    );
    expect(entry.narrative?.at(-1)).toBe(
      "That would have gone further under your $100.00 floor for Deluxe King than the price it started from, so it stopped there.",
    );
  });

  it("surfaces a manual-only run as a cycle with changes", () => {
    const cycles = buildCyclesFromAudit(
      [row({ base_price: 250, final_price: 250, details: withOverride() })],
      lookups(),
    );
    expect(cycles[0].has_changes).toBe(true);
    expect(cycles[0].changes[0].narrative).toEqual(["A manager set the base rate to $250.00."]);
  });
});

describe("buildApplications", () => {
  it("prefers matched_ladder_rules for action and observed metrics", () => {
    const apps = buildApplications(row().details, lookups());
    expect(apps).toHaveLength(1);
    expect(apps[0].rule_name).toBe("Busy-day bump");
    expect(apps[0].action).toEqual({ kind: "percent", direction: "increase", value: 10 });
    expect(apps[0].metrics).toEqual({ occupancy: 0.82, dta: 12, pickup_units: null, booking_speed: null });
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
    expect(apps[0].metrics).toEqual({ occupancy: 0.9, dta: 3, pickup_units: 9, booking_speed: null });
  });

  it("keeps where a pickup count started when a stronger rule's newer change opened it", () => {
    const d = details({
      active_pickup_effects: [{ event_id: "evt-9", rule_id: "rule-2", delta: "+12%" }],
      pickup_candidates: [
        {
          rule_id: "rule-2",
          outcome: "won",
          metrics: { occupancy: 0.9, dta: 3, net_pickup_units: 5, pickup_counted_since: "2026-09-18T12:05:00.000Z" },
          tie_break_trace: ["winner"],
        },
      ],
      application_order: ["pickup:evt-9"],
    });
    expect(buildApplications(d, lookups())[0].metrics).toEqual({
      occupancy: 0.9,
      dta: 3,
      pickup_units: 5,
      pickup_counted_since: "2026-09-18T12:05:00.000Z",
      booking_speed: null,
    });
  });

  it("keeps the days a Booking Speed fire counted when the fire it counted from cut them short", () => {
    const bs = { speed: "surging", rank: 3, label: "Surging", recent: 12, expected: 0.4, method: "comparable" };
    const fired = (booking_speed: Record<string, unknown>) =>
      buildApplications(
        details({
          active_pickup_effects: [{ event_id: "evt-9", rule_id: "rule-2", delta: "+12%" }],
          pickup_candidates: [{ rule_id: "rule-2", outcome: "won", metrics: { occupancy: 0.5, dta: 37, booking_speed }, tie_break_trace: ["winner"] }],
          application_order: ["pickup:evt-9"],
        }),
        lookups(),
      )[0].metrics?.booking_speed;
    expect(fired({ ...bs, window_days: 3, counted_from: "2026-09-17", full_window_days: 30 })).toEqual({
      label: "Surging",
      recent: 12,
      expected: 0.4,
      window_days: 3,
      counted_from: "2026-09-17",
    });
    // A fire that counted from the raise itself, on its day, carries the raise.
    expect(fired({ ...bs, window_days: 3, counted_from: "2026-09-17", full_window_days: 30, counted_since: "2026-09-17T12:00:00.000Z" })).toEqual({
      label: "Surging",
      recent: 12,
      expected: 0.4,
      window_days: 3,
      counted_from: "2026-09-17",
      counted_since: "2026-09-17T12:00:00.000Z",
    });
    // A rule that raises on a fast pace read a whole window's usual: it says
    // so, with that window.
    expect(
      fired({ ...bs, window_days: 2, counted_from: "2026-09-17", full_window_days: 7, counted_since: "2026-09-17T12:00:00.000Z", expected_over_full_window: true }),
    ).toEqual({
      label: "Surging",
      recent: 12,
      expected: 0.4,
      window_days: 2,
      counted_from: "2026-09-17",
      counted_since: "2026-09-17T12:00:00.000Z",
      expected_over_full_window: true,
      full_window_days: 7,
    });
    // A whole window, as every fire before this was: nothing more to say.
    expect(fired({ ...bs, window_days: 30 })).toEqual({ label: "Surging", recent: 12, expected: 0.4 });
    // A cut rule's reading, full days up to yesterday, says so, cut short or not.
    expect(fired({ ...bs, window_days: 30, counted_through: "2026-09-15" })).toEqual({
      label: "Surging",
      recent: 12,
      expected: 0.4,
      window_days: 30,
      counted_through: "2026-09-15",
    });
    expect(fired({ ...bs, window_days: 6, counted_from: "2026-09-18", full_window_days: 30, counted_through: "2026-09-23" })).toEqual({
      label: "Surging",
      recent: 12,
      expected: 0.4,
      window_days: 6,
      counted_from: "2026-09-18",
      counted_through: "2026-09-23",
    });
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
      '"Busy-day bump" raised this night 10%, from $200.00 to $220.00.',
      "It was 82% full, past the 70% mark you set.",
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
    expect(entry.narrative![entry.narrative!.length - 1]).toBe(
      "That would have gone past your $400.00 ceiling for Deluxe King, so it stopped there.",
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

  describe("heartbeat-only runs", () => {
    it("surfaces a run with no audit rows as a changeless cycle, dated from the heartbeat", () => {
      // write-on-change means a fully quiet run leaves nothing in
      // evaluation_audit — the heartbeat is the only evidence it happened.
      const cycles = buildCyclesFromAudit(
        [row({ evaluation_run_id: "changed", evaluated_at: "2026-07-28T09:00:00Z" })],
        lookups(),
        [{ evaluation_run_id: "quiet", evaluated_at: "2026-07-28T10:00:00Z" }],
      );
      expect(cycles).toHaveLength(2);
      expect(cycles[0]).toMatchObject({
        cycle: 2,
        timestamp: "2026-07-28T10:00:00Z",
        has_changes: false,
        changes: [],
      });
      expect(cycles[1]).toMatchObject({ cycle: 1, has_changes: true });
    });

    it("never lets a heartbeat shadow a run that has real audit rows", () => {
      const cycles = buildCyclesFromAudit(
        [row({ evaluation_run_id: "changed", evaluated_at: "2026-07-28T10:00:00Z" })],
        lookups(),
        [{ evaluation_run_id: "changed", evaluated_at: "2026-07-28T10:00:00Z" }],
      );
      expect(cycles).toHaveLength(1);
      expect(cycles[0]).toMatchObject({ has_changes: true });
      expect(cycles[0].changes).toHaveLength(1);
    });

    it("interleaves heartbeats with change runs by time before applying the top-10 cut", () => {
      // A heartbeat between two change runs must not get crowded out by
      // capping audit-derived runs to 10 BEFORE the merge.
      const changeRuns = Array.from({ length: 10 }, (_, i) =>
        row({
          evaluation_run_id: `change-${i}`,
          evaluated_at: `2026-07-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
        }),
      );
      const cycles = buildCyclesFromAudit(changeRuns, lookups(), [
        { evaluation_run_id: "quiet-newest", evaluated_at: "2026-07-20T00:00:00Z" },
      ]);
      expect(cycles).toHaveLength(10);
      expect(cycles[0]).toMatchObject({ timestamp: "2026-07-20T00:00:00Z", has_changes: false });
      // The oldest change run (change-0) should have been the one squeezed
      // out, not silently replaced by an arbitrary drop.
      expect(cycles.some((c) => c.timestamp === "2026-07-10T00:00:00Z")).toBe(false);
    });

    it("defaults to no heartbeats and behaves exactly as before", () => {
      const cycles = buildCyclesFromAudit(
        [row({ evaluation_run_id: "only", evaluated_at: "2026-07-28T10:00:00Z" })],
        lookups(),
      );
      expect(cycles).toHaveLength(1);
    });
  });
});

describe("measured room types in the change log", () => {
  const sets = (signal: string[], affected: string[]) => new Map([["rule-1", { signal, affected }]]);
  const names = new Map([
    ["rt-1", "Deluxe King"],
    ["rt-2", "Standard"],
    ["rt-3", "Queen"],
    ["court", "Court"],
  ]);

  it("names the measured room types only when they differ from the changed ones", () => {
    const narrative = (o: Partial<ChangelogLookups>) => buildEntry(row(), lookups({ roomTypeNames: names, ...o })).narrative;
    expect(narrative({ ruleRoomSets: sets(["rt-2", "rt-3"], ["rt-1"]) })).toEqual([
      '"Busy-day bump" raised this night 10%, from $200.00 to $220.00.',
      "Standard and Queen were 82% full, past the 70% mark you set.",
    ]);
    const plain = [
      '"Busy-day bump" raised this night 10%, from $200.00 to $220.00.',
      "It was 82% full, past the 70% mark you set.",
    ];
    expect(narrative({ ruleRoomSets: sets(["rt-1"], ["rt-1"]) })).toEqual(plain);
    // The court is changed but never measured: still one list.
    expect(narrative({ ruleRoomSets: sets(["rt-1"], ["rt-1", "court"]), countingRoomTypeIds: new Set(["rt-1", "rt-2", "rt-3"]) })).toEqual(plain);
    // No sets known (an old rule row, or none loaded): as before.
    expect(narrative({})).toEqual(plain);
  });
});

describe("an event rule that fired more than once on one night", () => {
  /** Two fires of rule-2 on the cell; only the newer one is this run's. */
  const stacked = () =>
    details({
      active_pickup_effects: [
        { event_id: "evt-1", rule_id: "rule-2", delta: "+12%", applied_at: "2026-07-21T10:00:00Z", fire_seq: 1 },
        { event_id: "evt-2", rule_id: "rule-2", delta: "+12%", applied_at: "2026-07-28T10:00:00Z", fire_seq: 2 },
      ],
      pickup_candidates: [
        {
          rule_id: "rule-2",
          outcome: "won",
          metrics: { occupancy: 0.9, dta: 3, net_pickup_units: 9 },
          tie_break_trace: ["winner"],
          event_id: "evt-2",
          fire_seq: 2,
        },
      ],
      application_order: ["pickup:evt-1", "pickup:evt-2"],
    });

  it("gives this run's numbers to the fire this run made, not to the one it stacked on", () => {
    const apps = buildApplications(stacked(), lookups());
    expect(apps).toHaveLength(2);
    expect(apps[0].metrics).toBeNull();
    expect(apps[0].repeat).toBeUndefined();
    expect(apps[1].metrics).toEqual({ occupancy: 0.9, dta: 3, pickup_units: 9, booking_speed: null });
    expect(apps[1].repeat).toBe(true);
  });

  it("still reads a row from before stacking, where the rule id named the winner", () => {
    const old = details({
      active_pickup_effects: [{ event_id: "evt-9", rule_id: "rule-2", delta: "+12%" }],
      pickup_candidates: [
        { rule_id: "rule-2", outcome: "won", metrics: { net_pickup_units: 4 }, tie_break_trace: ["winner"] },
      ],
      application_order: ["pickup:evt-9"],
    });
    expect(buildApplications(old, lookups())[0].metrics?.pickup_units).toBe(4);
  });

  it("narrates the second fire as the same rule going again", () => {
    const entry = buildEntry(
      row({ base_price: 200, final_price: 250.88, details: stacked() }),
      lookups(),
    );
    expect(entry.narrative).toEqual([
      '"Demand-spike catcher" raised this night 12%, from $200.00 to $224.00.',
      'Then "Demand-spike catcher" raised it another 12%, from $224.00 to $250.88.',
    ]);
  });
});

describe("buildRetirements", () => {
  const retired = () =>
    details({
      retired_pickup_effects: [
        {
          event_id: "evt-3",
          rule_id: "rule-2",
          delta: "+12%",
          applied_at: "2026-07-21T10:00:00Z",
          fire_seq: 1,
          reason: "bookings_cancelled",
          cancel_check: "either",
        },
      ],
    });

  it("names the rule behind a fire the run took off", () => {
    expect(buildRetirements(retired(), lookups().rules)).toEqual([
      { rule_name: "Demand-spike catcher", delta: "+12%", reason: "bookings_cancelled" },
    ]);
    expect(buildRetirements(details(), lookups().rules)).toEqual([]);
  });

  it("puts it in the entry before whatever is still applying", () => {
    const entry = buildEntry(row({ base_price: 200, final_price: 200, details: retired() }), lookups());
    expect(entry.narrative?.[0]).toBe(
      '"Demand-spike catcher" stopped applying an earlier 12% raise here: enough of the bookings behind it cancelled.',
    );
    expect(entry.rule_name).toBe("Demand-spike catcher");
  });
});

describe("buildAlertChoices", () => {
  const rows = [
    { rule_id: "rule-2", stay_date: "2026-11-16", choice: "stop" as const, at: "2026-09-17T12:00:00Z", by: "u1" },
    { rule_id: "rule-2", stay_date: "2026-11-14", choice: "stop" as const, at: "2026-09-17T12:00:00Z", by: "u1" },
    { rule_id: "rule-1", stay_date: "2026-11-14", choice: "keep_adjusting" as const, at: "2026-09-16T09:00:00Z", by: null },
  ];

  it("makes one item per answer, however many nights it settled, newest first", () => {
    const items = buildAlertChoices(rows, { rules: lookups().rules, setterNames: new Map([["u1", "Jake"]]) });
    expect(items).toHaveLength(2);
    expect(items[0].nights).toBe(2);
    expect(items[0].first_night).toBe("2026-11-14");
    expect(items[0].last_night).toBe("2026-11-16");
    // "Demand-spike catcher" raises, and a stop does not hold a raise against
    // the cancellation check.
    expect(items[0].title).toBe(
      'Jake stopped "Demand-spike catcher" on 2 nights. The raises it already made stay, unless enough of the bookings behind them cancel.',
    );
    expect(items[1].title).toBe('A manager told "Busy-day bump" to carry on with Sat, Nov 14 2026.');
    expect(items.every(isRuleAlertChoice)).toBe(true);
  });

  it("says a cut it already made stays, because nothing MAYA does takes one back", () => {
    const cutter = new Map(lookups().rules);
    cutter.set("rule-2", { ...cutter.get("rule-2")!, name: "Slow-date rescue", action_direction: "decrease" });
    const items = buildAlertChoices([rows[0]], { rules: cutter });
    expect(items[0].title).toBe('A manager stopped "Slow-date rescue" on Mon, Nov 16 2026. What it already cut stays.');
  });

  it("says a manager let the rule run again, and what that leaves the rule free to do", () => {
    // Taking the answer back is its own line: without it, resuming some of
    // the nights an answer covered would quietly rewrite the entry that
    // answer left, down to the nights nobody took it off.
    const resumed = [
      { rule_id: "rule-2", stay_date: "2026-11-16", choice: "resume" as const, at: "2026-09-18T08:00:00Z", by: "u1" },
      { rule_id: "rule-2", stay_date: "2026-11-14", choice: "resume" as const, at: "2026-09-18T08:00:00Z", by: "u1" },
    ];
    const items = buildAlertChoices([...rows, ...resumed], {
      rules: lookups().rules,
      setterNames: new Map([["u1", "Jake"]]),
    });
    // Newest first: the resume sits above the answer it took back.
    expect(items[0]).toMatchObject({ choice: "resume", nights: 2, timestamp: "2026-09-18T08:00:00Z" });
    expect(items[0].title).toBe(
      'Jake let "Demand-spike catcher" run again on 2 nights. It can start adjusting again from the next pricing run.',
    );
    expect(items[1].choice).toBe("stop");
    expect(items.every(isRuleAlertChoice)).toBe(true);
  });

  it("says nothing it cannot back up when the rule is gone", () => {
    const items = buildAlertChoices([rows[0]], { rules: new Map() });
    expect(items[0].title).toBe(
      'A manager stopped "A rule" on Mon, Nov 16 2026. What it already cut stays.',
    );
    expect(items[0].title).not.toMatch(/—/);
  });
});

describe("quiet checks between changes", () => {
  /**
   * A hotel's run log, one run every five minutes from 10:00. `changed` runs
   * wrote audit rows and show a change; `hidden` runs wrote audit rows that
   * show none (cells_changed > 0, nothing isChangeRow keeps). The rest wrote
   * nothing.
   */
  type LogRun = { id: string; at: string; cells_changed: number; shows: boolean };
  const at = (n: number) => new Date(Date.parse("2026-09-24T10:00:00Z") + n * 300_000).toISOString();
  function runLog(total: number, changed: number[] = [], hidden: number[] = []): LogRun[] {
    return Array.from({ length: total }, (_, n) => ({
      id: `run-${n}`,
      at: at(n),
      cells_changed: changed.includes(n) || hidden.includes(n) ? 3 : 0,
      shows: changed.includes(n),
    }));
  }

  /**
   * What the route does, with the run log as a list instead of a table.
   * `landsLate` runs are in the log by the time the gaps are counted, but
   * were not when the runs to read were chosen.
   */
  async function timeline(log: LogRun[], splitAt: string[] = [], landsLate: LogRun[] = []) {
    const newestFirst = [...log].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const candidates: RunHeartbeat[] = newestFirst
      .filter((r) => r.cells_changed > 0)
      .slice(0, MAX_CANDIDATE_RUNS + 1)
      .map((r) => ({ evaluation_run_id: r.id, evaluated_at: r.at }));
    const read: string[] = [];
    const { shown, folded, readBackTo } = await findShownRuns(candidates, async (run) => {
      read.push(run.evaluation_run_id);
      const shows = log.find((r) => r.id === run.evaluation_run_id)!.shows;
      return { evaluation_run_id: run.evaluation_run_id, timestamp: run.evaluated_at, hasChanges: shows, topRows: [] };
    });
    const gaps = planQuietGaps({ changes: shown.map((r) => r.timestamp), splitAt, readBackTo });
    const counted = [...log, ...landsLate];
    const quiet = await buildQuietChecks(
      gaps,
      async (gap: QuietGap) => {
        // The route's count: runs that wrote no audit rows.
        const inside = counted
          .filter((r) => r.cells_changed === 0 && inQuietGap(gap, r.at))
          .map((r) => r.at)
          .sort();
        return { checks: inside.length, first_at: inside[0] ?? null, last_at: inside[inside.length - 1] ?? null };
      },
      folded,
    );
    return { shown: shown.map((r) => r.evaluation_run_id), quiet, read, readBackTo, folded };
  }

  it("counts the checks after the newest change into one line above it", async () => {
    const { shown, quiet } = await timeline(runLog(6, [2]));
    expect(shown).toEqual(["run-2"]);
    expect(quiet[0]).toMatchObject({ kind: "quiet_checks", checks: 3, first_at: at(3), timestamp: at(5) });
    expect(quiet[0].just_before).toBeUndefined();
    expect(isQuietChecks(quiet[0])).toBe(true);
  });

  it("counts every check before the only change when the log read back to the first one", async () => {
    const { quiet } = await timeline(runLog(6, [4]));
    // Newest first: the one check after the change, then the four before it.
    expect(quiet.map((q) => [q.checks, q.first_at, q.timestamp])).toEqual([
      [1, at(5), at(5)],
      [4, at(0), at(3)],
    ]);
    expect(quiet.every((q) => !q.just_before)).toBe(true);
  });

  it("puts one line between two changes, and none between two in a row", async () => {
    const { shown, quiet } = await timeline(runLog(8, [1, 2, 7]));
    expect(shown).toEqual(["run-7", "run-2", "run-1"]);
    expect(quiet.map((q) => [q.checks, q.first_at, q.timestamp])).toEqual([
      [4, at(3), at(6)],
      [1, at(0), at(0)],
    ]);
  });

  it("folds a run that wrote audit rows but shows no change into the quiet line around it", async () => {
    const { shown, quiet, read, folded } = await timeline(runLog(8, [1, 6], [3]));
    expect(read).toEqual(["run-6", "run-3", "run-1"]);
    expect(shown).toEqual(["run-6", "run-1"]);
    expect(folded).toEqual([at(3)]);
    // run-2, run-3, run-4 and run-5: the hidden one is one of the four.
    expect(quiet.find((q) => q.first_at === at(2))).toMatchObject({ checks: 4, timestamp: at(5) });
    // At either end of a stretch, it moves the end too.
    const edge = await timeline(runLog(6, [0], [5, 1]));
    expect(edge.quiet.map((q) => [q.checks, q.first_at, q.timestamp])).toEqual([[5, at(1), at(5)]]);
  });

  it("never calls a run that landed while the log was reading a quiet check", async () => {
    // Two runs land after the runs to read were chosen: one that changed a
    // price and one that did not. Only the quiet one is counted.
    const late = [
      { id: "run-8", at: at(8), cells_changed: 2, shows: true },
      { id: "run-9", at: at(9), cells_changed: 0, shows: false },
    ];
    const { quiet } = await timeline(runLog(8, [2]), [], late);
    expect(quiet[0]).toMatchObject({ checks: 6, first_at: at(3), timestamp: at(9) });
  });

  it("splits a quiet stretch where an owner's answer sits, a run at the same instant going above it", async () => {
    const answer = at(4);
    const { quiet } = await timeline(runLog(9, [0]), [answer]);
    expect(quiet.map((q) => [q.checks, q.first_at, q.timestamp])).toEqual([
      [5, at(4), at(8)],
      [3, at(1), at(3)],
    ]);
    // Between two checks, it splits them the same way.
    const between = new Date(Date.parse(at(6)) + 60_000).toISOString();
    const split = await timeline(runLog(9, [0]), [between]);
    expect(split.quiet.map((q) => q.checks)).toEqual([2, 6]);
  });

  it("covers every check since the first with one line on a hotel that never changed a price", async () => {
    const { shown, quiet, readBackTo } = await timeline(runLog(12));
    expect(shown).toEqual([]);
    expect(readBackTo).toBeNull();
    expect(quiet).toEqual([
      { kind: "quiet_checks", id: `quiet-${at(0)}-${at(11)}`, timestamp: at(11), first_at: at(0), checks: 12 },
    ]);
  });

  it("gives a single quiet check a line of its own", async () => {
    const { quiet } = await timeline(runLog(3, [0, 2]));
    expect(quiet).toEqual([
      { kind: "quiet_checks", id: `quiet-${at(1)}-${at(1)}`, timestamp: at(1), first_at: at(1), checks: 1 },
    ]);
  });

  it("shows the newest changes in full and says the last line is the stretch just before the oldest of them", async () => {
    // Twelve changes, every third run: the log reads the newest ten, and the
    // one after them marks where it stopped.
    const changed = Array.from({ length: 12 }, (_, i) => 1 + i * 3);
    const { shown, quiet, readBackTo } = await timeline(runLog(40, changed));
    expect(shown).toHaveLength(MAX_CHANGED_RUNS);
    expect(shown[shown.length - 1]).toBe("run-7");
    expect(readBackTo).toBe(at(4));
    const last = quiet[quiet.length - 1];
    // run-5 and run-6: nothing at or before run-4 is counted.
    expect(last).toMatchObject({ checks: 2, first_at: at(5), timestamp: at(6), just_before: true });
    expect(quiet.filter((q) => q.just_before)).toHaveLength(1);
  });

  it("stops reading after MAX_CANDIDATE_RUNS runs that show nothing, and counts only what it read past", async () => {
    const hidden = Array.from({ length: MAX_CANDIDATE_RUNS + 5 }, (_, i) => i * 2);
    const log = runLog(hidden.length * 2, [], hidden);
    const { shown, quiet, read, readBackTo } = await timeline(log);
    expect(read).toHaveLength(MAX_CANDIDATE_RUNS);
    expect(shown).toEqual([]);
    const oldestRead = hidden[hidden.length - MAX_CANDIDATE_RUNS];
    expect(readBackTo).toBe(at(oldestRead - 2));
    expect(quiet).toHaveLength(1);
    expect(quiet[0]).toMatchObject({ first_at: at(oldestRead - 1), timestamp: at(log.length - 1) });
    expect(quiet[0].checks).toBe(log.length - oldestRead + 1);
    // Nothing changed above it, so there is no change for it to sit before.
    expect(quiet[0].just_before).toBeUndefined();
  });

  it("drops answers from before where it stopped reading, and never counts a gap whose ends meet", () => {
    const gaps = planQuietGaps({ changes: [at(5)], splitAt: [at(5), at(1), at(1)], readBackTo: at(2) });
    // The answer at the change's own instant sits below it, with no run between.
    expect(gaps).toEqual([
      { before: null, after: { at: at(5), inclusive: false }, just_before: false },
      { before: at(5), after: { at: at(2), inclusive: false }, just_before: true },
    ]);
    expect(inQuietGap(gaps[1], at(2))).toBe(false);
    expect(inQuietGap(gaps[1], at(3))).toBe(true);
    expect(inQuietGap(gaps[0], at(5))).toBe(false);
  });
});
