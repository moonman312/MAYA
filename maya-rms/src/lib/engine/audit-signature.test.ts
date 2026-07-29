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
import { auditSignature, writeAudit, type AuditInput } from "./audit";

function fakeSupabase() {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, inserted };
}

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

describe("writeAudit write-on-change", () => {
  it("always writes when there is no previous signature", async () => {
    const { client, inserted } = fakeSupabase();
    const wrote = await writeAudit(client, baseInput({ previousSignature: null }));
    expect(wrote).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  it("skips the insert when the signature matches the previous run", async () => {
    const { client, inserted } = fakeSupabase();
    const sig = auditSignature(110, [], "none");
    const wrote = await writeAudit(client, baseInput({ previousSignature: sig }));
    expect(wrote).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("still writes when a persistently active rule keeps the price identical run over run — same signature, but the FIRST time it activated it must have written", async () => {
    // Simulates a rule that activated last run (no previous signature then,
    // so it wrote) and stays active with an unchanged effect this run.
    const { client, inserted } = fakeSupabase();
    const active = assembled({
      ladder_effects: [{ rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 10 }],
      pre_clamp_price: 110,
      final_price: 110,
    });
    const detailsLikeSignature = auditSignature(110, ["ladder:r1"], "none");

    // Run N-1: activation, nothing to compare against yet.
    const first = await writeAudit(client, baseInput({ assembled: active, previousSignature: null }));
    // Run N: same effect, same price — this is the case that used to flood
    // the table with an identical row every five minutes forever.
    const second = await writeAudit(
      client,
      baseInput({ assembled: active, previousSignature: detailsLikeSignature }),
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(inserted).toHaveLength(1);
  });

  it("writes again once the price actually moves", async () => {
    const { client, inserted } = fakeSupabase();
    const sig = auditSignature(110, [], "none");
    const wrote = await writeAudit(
      client,
      baseInput({ assembled: assembled({ final_price: 121 }), previousSignature: sig }),
    );
    expect(wrote).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  it("writes again when the applied-effects set changes even if the final price coincidentally matches", async () => {
    const { client, inserted } = fakeSupabase();
    const sig = auditSignature(110, ["ladder:r1"], "none");
    const wrote = await writeAudit(
      client,
      baseInput({
        assembled: assembled({
          ladder_effects: [{ rule_id: "r2", action_kind: "percent", action_direction: "increase", action_value: 10 }],
        }),
        previousSignature: sig,
      }),
    );
    expect(wrote).toBe(true);
    expect(inserted).toHaveLength(1);
  });
});
