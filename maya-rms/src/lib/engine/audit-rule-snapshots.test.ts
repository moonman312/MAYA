/**
 * Each audit row keeps the rules it names as the run had them, and the
 * version behind each fire (audit A46), so the change log can tell a row as
 * it was decided after the rule is edited, renamed or deleted. Not part of
 * the signature: a rename or an edit alone writes no row. Both engine copies.
 */
import { describe, expect, it } from "vitest";
import type { EngineRule } from "@/types/domain";
import { auditBaseKey, auditSignature, buildAuditRow, ruleSnapshotOf, type AuditInput } from "./audit";
import {
  auditBaseKey as edgeAuditBaseKey,
  auditSignature as edgeAuditSignature,
  buildAuditRow as edgeBuildAuditRow,
  ruleSnapshotOf as edgeRuleSnapshotOf,
} from "../../../supabase/functions/_shared/engine/audit";
import { pickupEffectOf, type AssembledPrice } from "./pricing";
import { pickupEffectOf as edgePickupEffectOf } from "../../../supabase/functions/_shared/engine/pricing";

function rule(o: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "r-busy",
    hotel_id: "h1",
    name: "Busy bump",
    is_active: true,
    version: 3,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    priority: 1,
    is_pickup_rule: false,
    condition: { occupancy_operator: "gt", occupancy_threshold: 0.7, dta_operator: null, dta_threshold_days: null },
    signal_room_type_ids: ["garden", "loft"],
    affected_room_type_ids: ["garden", "loft"],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...o,
  };
}

function assembled(o: Partial<AssembledPrice> = {}): AssembledPrice {
  return {
    stay_date: "2026-10-10",
    room_type_id: "garden",
    base_price: 200,
    base_source: "calendar",
    floor_price: 50,
    ceiling_price: 500,
    ladder_effects: [{ rule_id: "r-busy", action_kind: "percent", action_direction: "increase", action_value: 10 }],
    pickup_effects: [
      { event_id: "ev-1", rule_id: "r-surge", action_kind: "percent", action_direction: "increase", action_value: 5, applied_at: "2026-09-25T10:00:00Z", fire_seq: 1, rule_version: 2 },
    ],
    pre_clamp_price: 231,
    final_price: 231,
    clamped_by: "none",
    ...o,
  };
}

const counting = (id: string) => id !== "court";

describe.each([
  ["app", { buildAuditRow, ruleSnapshotOf, pickupEffectOf, auditSignature, auditBaseKey }],
  [
    "edge",
    {
      buildAuditRow: edgeBuildAuditRow,
      ruleSnapshotOf: edgeRuleSnapshotOf,
      pickupEffectOf: edgePickupEffectOf,
      auditSignature: edgeAuditSignature,
      auditBaseKey: edgeAuditBaseKey,
    },
  ],
] as const)("rule snapshots on audit rows (%s copy)", (_copy, engine) => {
  const snapshots = new Map([
    ["r-busy", engine.ruleSnapshotOf(rule(), counting)],
    ["r-surge", engine.ruleSnapshotOf(rule({ id: "r-surge", name: "Late surge", version: 2, condition: { pickup_operator: "gt", pickup_threshold: 4 } }), counting)],
    ["r-other", engine.ruleSnapshotOf(rule({ id: "r-other", name: "Not on this night" }), counting)],
  ]);
  const input = (o: Partial<AuditInput> = {}): AuditInput => ({
    runId: "run-1",
    hotelId: "h1",
    evalTs: "2026-09-25T10:00:00Z",
    assembled: assembled(),
    ladderResults: [],
    pickupWinners: [],
    pickupLosers: [],
    pickupWriteFailures: [],
    basePrices: new Map(),
    ruleSnapshots: snapshots,
    ...o,
  });

  it("keeps a rule's name, version and the parts of its condition that are set", () => {
    expect(engine.ruleSnapshotOf(rule(), counting)).toEqual({
      name: "Busy bump",
      version: 3,
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 },
    });
  });

  it("keeps what a rule measures only when that is not what it changes, rooms only", () => {
    expect(
      engine.ruleSnapshotOf(rule({ signal_room_type_ids: ["loft", "garden", "court"], affected_room_type_ids: ["garden"] }), counting).measured_room_type_ids,
    ).toEqual(["garden", "loft"]);
    // A court that isn't a room doesn't make it measure differently.
    expect(engine.ruleSnapshotOf(rule({ signal_room_type_ids: ["garden", "court"], affected_room_type_ids: ["garden"] }), counting)).not.toHaveProperty(
      "measured_room_type_ids",
    );
  });

  it("stores the rules the row names, and the version behind each fire", () => {
    const row = engine.buildAuditRow(input());
    const details = row!.details as Record<string, unknown>;
    expect(details.rule_snapshots).toEqual({
      "r-busy": { name: "Busy bump", version: 3, condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 } },
      "r-surge": { name: "Late surge", version: 2, condition: { pickup_operator: "gt", pickup_threshold: 4 } },
    });
    expect(details.active_pickup_effects).toEqual([
      { event_id: "ev-1", rule_id: "r-surge", delta: "+5%", applied_at: "2026-09-25T10:00:00Z", fire_seq: 1, rule_version: 2 },
    ]);
  });

  it("names a fire taken off too, and stores nothing when no rule is named", () => {
    const off = engine.buildAuditRow(
      input({
        assembled: assembled({ ladder_effects: [], pickup_effects: [], pre_clamp_price: 200, final_price: 200 }),
        retiredPickupEffects: [
          {
            fire: {
              id: "ev-0",
              rule_id: "r-surge",
              action_kind: "percent",
              action_direction: "increase",
              action_value: 5,
              applied_at: "2026-09-20T10:00:00Z",
              fire_seq: 1,
              cancel_check: "net_units",
            },
            reason: "bookings_cancelled",
          },
        ] as never,
      }),
    );
    expect(Object.keys((off!.details as Record<string, unknown>).rule_snapshots as object)).toEqual(["r-surge"]);
    const bare = engine.buildAuditRow(input({ assembled: assembled({ ladder_effects: [], pickup_effects: [], pre_clamp_price: 200, final_price: 200 }) }));
    expect(bare!.details).not.toHaveProperty("rule_snapshots");
  });

  it("is not part of the signature: a rename or an edit alone writes no row", () => {
    const first = engine.buildAuditRow(input())!;
    const details = first.details as { application_order: string[]; clamped_by: "none"; base_source?: string };
    const signature = engine.auditSignature(Number(first.final_price), details.application_order, details.clamped_by, engine.auditBaseKey(details as never));
    const renamed = new Map(snapshots);
    renamed.set("r-busy", engine.ruleSnapshotOf(rule({ name: "Busy nights", version: 4, condition: { occupancy_operator: "gt", occupancy_threshold: 0.9 } }), counting));
    expect(engine.buildAuditRow(input({ ruleSnapshots: renamed, previousSignature: signature }))).toBeNull();
    // Any other change still writes, with the rule as it is now.
    const moved = engine.buildAuditRow(input({ ruleSnapshots: renamed, previousSignature: signature, assembled: assembled({ final_price: 240, pre_clamp_price: 240 }) }));
    expect(((moved!.details as Record<string, unknown>).rule_snapshots as Record<string, { name: string }>)["r-busy"].name).toBe("Busy nights");
  });

  it("reads the version off a fire's row", () => {
    expect(
      engine.pickupEffectOf({ id: "ev-1", rule_id: "r-surge", rule_version: "2", action_kind: "percent", action_direction: "increase", action_value: "5" }),
    ).toMatchObject({ event_id: "ev-1", rule_version: 2 });
    expect(engine.pickupEffectOf({ id: "ev-1", rule_id: "r-surge", action_kind: "percent", action_direction: "increase", action_value: 5 })).not.toHaveProperty(
      "rule_version",
    );
  });
});
