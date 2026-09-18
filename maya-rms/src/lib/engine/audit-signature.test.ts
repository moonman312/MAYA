/**
 * Write-on-change: an unstable cell (price moved, or the applied-effects
 * set changed) always gets a new row; a stable cell — even one with a
 * persistently active rule — writes nothing once its signature repeats.
 * That's the whole storage fix: the engine used to insert one row per
 * priced cell on every five-minute run regardless of whether anything
 * happened.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import type { AssembledPrice } from "./pricing";
import {
  auditBaseKey,
  auditSignature,
  loadLastAuditSignatures,
  resetAuditSignaturesLogOnce,
  writeAudit,
  type AuditInput,
} from "./audit";
import { rng } from "./booking-speed-legacy.test";
import { FakeRpcError, fakeSupabase as sharedFake, missingFunction, type FakeRow } from "./fake-supabase.test";

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
    base_source: "calendar",
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

/* ── loadLastAuditSignatures ─────────────────────────────────────────── */

/** The loader as it was: full details, newest first, no tie-break. */
async function legacyLoadLastAuditSignatures(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<Map<string, string>> {
  const PAGE = 1000;
  const signatures = new Map<string, string>();
  const seenKeys = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data } = await supabase
      .from("evaluation_audit")
      .select("stay_date, room_type_id, final_price, details")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("evaluated_at", { ascending: false })
      .range(from, from + PAGE - 1);
    const rows = data ?? [];
    for (const r of rows) {
      const key = `${r.stay_date}|${r.room_type_id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const d = r.details ?? {};
      signatures.set(key, auditSignature(Number(r.final_price), d.application_order ?? [], d.clamped_by ?? "none", auditBaseKey(d)));
    }
    if (rows.length < PAGE) break;
  }
  return signatures;
}

function auditFixture(seed: number, runs: number, opts: { ties?: boolean } = {}): FakeRow[] {
  const r = rng(seed);
  const rows: FakeRow[] = [];
  let id = 0;
  const types = ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000003"];
  for (let run = 0; run < runs; run++) {
    const at = new Date(Date.parse("2026-08-01T00:00:00Z") + run * 300_000).toISOString();
    for (let d = 0; d < 60; d++) {
      for (const t of types) {
        if (r() < 0.6) continue; // write-on-change: most cells are quiet
        const copies = opts.ties && r() < 0.1 ? 2 : 1;
        for (let c = 0; c < copies; c++) {
          const manual = r() < 0.1;
          rows.push({
            id: `e0000000-0000-4000-8000-${String(1_000_000 - ++id).padStart(12, "0")}`,
            hotel_id: r() < 0.03 ? "h2" : "h1",
            stay_date: addDays("2026-08-01", d),
            room_type_id: t,
            evaluated_at: at,
            final_price: 100 + Math.floor(r() * 30),
            details: {
              application_order: r() < 0.3 ? [] : [`ladder:r${Math.floor(r() * 3)}`, `pickup:e${Math.floor(r() * 3)}`],
              ...(r() < 0.9 ? { clamped_by: r() < 0.2 ? "ceiling" : "none" } : {}),
              base_source: manual ? "manual" : "calendar",
              ...(manual ? { manual_override: { set_by: "u1", set_at: "2026-07-30T00:00:00Z" } } : {}),
              pickup_candidates: [{ big: "x".repeat(200) }],
            },
          });
        }
      }
    }
  }
  return rows;
}

describe("loadLastAuditSignatures", () => {
  it("gives the old loader's answer with far less read, past the 1,000-row page", async () => {
    const rows = auditFixture(1, 40);
    expect(rows.length).toBeGreaterThan(2500);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    resetAuditSignaturesLogOnce();
    const { client: oldClient } = sharedFake({ evaluation_audit: rows }, { maxRows: 1000 });
    const expected = await legacyLoadLastAuditSignatures(oldClient, "h1", "2026-08-01", "2026-09-29");
    expect(expected.size).toBeGreaterThan(100);

    const { client: preMigration, calls } = sharedFake(
      { evaluation_audit: rows },
      { maxRows: 1000, rpc: (fn) => new FakeRpcError(missingFunction(fn)) },
    );
    expect(await loadLastAuditSignatures(preMigration, "h1", "2026-08-01", "2026-09-29")).toEqual(expected);
    const read = calls.find((c) => c.table === "evaluation_audit");
    expect(read?.columns).not.toContain(" details,");
    expect(read?.columns).toContain("details->application_order");

    const { client: migrated } = sharedFake({ evaluation_audit: rows }, { maxRows: 1000 });
    expect(await loadLastAuditSignatures(migrated, "h1", "2026-08-01", "2026-09-29")).toEqual(expected);
    spy.mockRestore();
  });

  it("with ties on evaluated_at, both paths pick the same row per cell", async () => {
    const rows = auditFixture(2, 12, { ties: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client: pre } = sharedFake({ evaluation_audit: rows }, { maxRows: 1000, rpc: (fn) => new FakeRpcError(missingFunction(fn)) });
    const { client: mig } = sharedFake({ evaluation_audit: rows }, { maxRows: 1000 });
    expect(await loadLastAuditSignatures(mig, "h1", "2026-08-01", "2026-09-29")).toEqual(
      await loadLastAuditSignatures(pre, "h1", "2026-08-01", "2026-09-29"),
    );
    spy.mockRestore();
  });

  it("throws on a real failure", async () => {
    const { client } = sharedFake({}, { rpc: () => new FakeRpcError({ code: "57014", message: "statement timeout" }) });
    await expect(loadLastAuditSignatures(client, "h1", "2026-08-01", "2026-09-29")).rejects.toThrow(/prior audit signatures/);
  });
});
