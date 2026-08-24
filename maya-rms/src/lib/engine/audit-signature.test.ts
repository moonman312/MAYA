/**
 * Write-on-change: an unstable cell (price moved, or the applied-effects
 * set changed) always gets a new row; a stable cell — even one with a
 * persistently active rule — writes nothing once its signature repeats.
 * That's the whole storage fix: the engine used to insert one row per
 * priced cell on every five-minute run regardless of whether anything
 * happened.
 */
import { describe, expect, it } from "vitest";
import type { AssembledPrice } from "./pricing";
import { auditSignature, buildAuditRow, type AuditInput } from "./audit";

function assembled(overrides: Partial<AssembledPrice> = {}): AssembledPrice {
  return {
    stay_date: "2026-09-01",
    room_type_id: "rt1",
    base_price: 100,
    floor_price: 50,
    ceiling_price: 500,
    ladder_effects: [],
    pickup_effects: [],
    pre_clamp_price: 110,
    final_price: 110,
    clamped_by: "none",
    ...overrides,
  };
}

function baseInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    runId: "run1",
    hotelId: "h1",
    evalTs: "2026-08-01T00:00:00Z",
    assembled: assembled(),
    ladderResults: [],
    pickupWinners: [],
    pickupLosers: [],
    pickupIdempotentSkips: [],
    pickupWriteFailures: [],
    basePrices: new Map(),
    ...overrides,
  };
}

describe("auditSignature", () => {
  it("is stable for identical inputs and differs when any part changes", () => {
    const a = auditSignature(110, ["ladder:r1"], "none");
    const b = auditSignature(110, ["ladder:r1"], "none");
    expect(a).toBe(b);
    expect(auditSignature(111, ["ladder:r1"], "none")).not.toBe(a);
    expect(auditSignature(110, ["ladder:r1", "pickup:e1"], "none")).not.toBe(a);
    expect(auditSignature(110, ["ladder:r1"], "ceiling")).not.toBe(a);
  });
});

describe("buildAuditRow write-on-change", () => {
  it("always builds a row when there is no previous signature", () => {
    expect(buildAuditRow(baseInput({ previousSignature: null }))).not.toBeNull();
  });

  it("skips the row when the signature matches the previous run", () => {
    const sig = auditSignature(110, [], "none");
    expect(buildAuditRow(baseInput({ previousSignature: sig }))).toBeNull();
  });

  it("still writes when a persistently active rule keeps the price identical run over run — same signature, but the FIRST time it activated it must have written", () => {
    // Simulates a rule that activated last run (no previous signature then,
    // so it wrote) and stays active with an unchanged effect this run.
    const active = assembled({
      ladder_effects: [{ rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 10 }],
      pre_clamp_price: 110,
      final_price: 110,
    });
    const detailsLikeSignature = auditSignature(110, ["ladder:r1"], "none");

    // Run N-1: activation, nothing to compare against yet.
    const first = buildAuditRow(baseInput({ assembled: active, previousSignature: null }));
    // Run N: same effect, same price — this is the case that used to flood
    // the table with an identical row every five minutes forever.
    const second = buildAuditRow(
      baseInput({ assembled: active, previousSignature: detailsLikeSignature }),
    );
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("writes again once the price actually moves", () => {
    const sig = auditSignature(110, [], "none");
    const row = buildAuditRow(
      baseInput({ assembled: assembled({ final_price: 121 }), previousSignature: sig }),
    );
    expect(row).not.toBeNull();
    expect(row?.final_price).toBe(121);
  });

  it("writes again when the applied-effects set changes even if the final price coincidentally matches", () => {
    const sig = auditSignature(110, ["ladder:r1"], "none");
    const row = buildAuditRow(
      baseInput({
        assembled: assembled({
          ladder_effects: [{ rule_id: "r2", action_kind: "percent", action_direction: "increase", action_value: 10 }],
        }),
        previousSignature: sig,
      }),
    );
    expect(row).not.toBeNull();
  });
});
