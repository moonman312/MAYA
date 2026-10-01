/**
 * The 90-day clean-up of evaluation_audit keeps each night's newest row
 * while the night is still ahead (audit A31). Both engine copies hand the
 * purge to engine_audit_purge (99_supabase_migration_pricing_records_v1.sql,
 * held to it in PGlite by pricing-records-migration-sql.test.ts); before the
 * migration they delete only the old rows of nights that have passed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { purgeOldAuditRows } from "./audit";
import { purgeOldAuditRows as edgePurgeOldAuditRows } from "../../../supabase/functions/_shared/engine/audit";
import { fakeSupabase, FakeRpcError, missingFunction, type FakeRow } from "./fake-supabase.test";
import type { SupabaseClient } from "@supabase/supabase-js";

const NOW = "2026-10-01T12:00:00Z";
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => vi.useRealTimers());

const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

function rows(): FakeRow[] {
  return [
    // A night ahead, unchanged for 120 days: its only row.
    { id: "a1", hotel_id: "h1", stay_date: "2027-03-01", room_type_id: "rt1", evaluated_at: daysAgo(120) },
    // A night ahead with a newer row.
    { id: "b1", hotel_id: "h1", stay_date: "2026-12-01", room_type_id: "rt1", evaluated_at: daysAgo(150) },
    { id: "b2", hotel_id: "h1", stay_date: "2026-12-01", room_type_id: "rt1", evaluated_at: daysAgo(10) },
    // A night that passed long ago.
    { id: "c1", hotel_id: "h1", stay_date: "2026-05-01", room_type_id: "rt1", evaluated_at: daysAgo(160) },
    // Another hotel's.
    { id: "d1", hotel_id: "h2", stay_date: "2026-05-01", room_type_id: "rt9", evaluated_at: daysAgo(160) },
  ];
}

describe.each([
  ["app", purgeOldAuditRows],
  ["edge", edgePurgeOldAuditRows],
])("the audit purge (%s copy)", (_copy, purge) => {
  it("asks engine_audit_purge for this hotel and the window, and deletes nothing itself", async () => {
    const seen: unknown[] = [];
    const { client, tables, calls } = fakeSupabase(
      { evaluation_audit: rows() },
      { rpc: (fn, args) => (fn === "engine_audit_purge" ? (seen.push(args), 2) : undefined) },
    );
    await purge(client as unknown as SupabaseClient, "h1");
    expect(seen).toEqual([{ p_hotel_id: "h1", p_days: 90 }]);
    expect(calls.some((c) => c.table === "evaluation_audit" && c.op === "delete")).toBe(false);
    expect(tables.evaluation_audit).toHaveLength(5);
  });

  it("before the migration: only old rows of nights that have passed go, so no night ahead loses its newest row", async () => {
    const { client, tables } = fakeSupabase(
      { evaluation_audit: rows() },
      { rpc: (fn) => (fn === "engine_audit_purge" ? new FakeRpcError(missingFunction(fn)) : undefined) },
    );
    await purge(client as unknown as SupabaseClient, "h1");
    expect(tables.evaluation_audit.map((r) => r.id).sort()).toEqual(["a1", "b1", "b2", "d1"]);
  });

  it("any other failure is the purge's error, for the run's bookkeeping to log", async () => {
    const { client } = fakeSupabase(
      { evaluation_audit: rows() },
      { rpc: (fn) => (fn === "engine_audit_purge" ? new FakeRpcError({ code: "57014", message: "statement timeout" }) : undefined) },
    );
    await expect(purge(client as unknown as SupabaseClient, "h1")).rejects.toThrow("Audit purge failed: statement timeout");
  });
});
