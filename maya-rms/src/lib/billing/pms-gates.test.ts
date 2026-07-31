/**
 * Per-PMS access-code gates.
 *
 * The one direction that matters is failing SAFE: a missing row or a broken
 * read must read as "code required," never as open. The cost of that default
 * is a confused admin; the cost of the opposite is an unvetted signup reaching
 * a paid subscription with nothing checked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listPmsSignupGates, pmsSignupCodeRequired, setPmsSignupCodeRequired } from "./pms-gates";

function fakeAdmin(opts: {
  row?: { requires_signup_code: boolean } | null;
  rows?: { pms_type: string; requires_signup_code: boolean; updated_at: string | null }[];
  selectError?: string;
  upsertError?: string;
  logError?: string;
}) {
  const upserts: Record<string, unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const admin = {
    from: (table: string) => {
      if (table !== "pms_signup_gates") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              opts.selectError
                ? { data: null, error: { message: opts.selectError } }
                : { data: opts.row ?? null, error: null },
          }),
          order: async () =>
            opts.selectError
              ? { data: null, error: { message: opts.selectError } }
              : { data: opts.rows ?? [], error: null },
        }),
        upsert: (row: Record<string, unknown>) => {
          upserts.push(row);
          return Promise.resolve(
            opts.upsertError ? { error: { message: opts.upsertError } } : { error: null },
          );
        },
      };
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      logs.push({ name, args });
      return Promise.resolve(opts.logError ? { error: { message: opts.logError } } : { error: null });
    },
  };
  return { admin: admin as unknown as SupabaseClient, upserts, logs };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("pmsSignupCodeRequired fails toward more scarcity, never less", () => {
  it("requires a code when the row says so", async () => {
    const { admin } = fakeAdmin({ row: { requires_signup_code: true } });
    expect(await pmsSignupCodeRequired(admin, "cloudbeds")).toBe(true);
  });

  it("allows no code once the row is explicitly flipped off", async () => {
    const { admin } = fakeAdmin({ row: { requires_signup_code: false } });
    expect(await pmsSignupCodeRequired(admin, "cloudbeds")).toBe(false);
  });

  it("requires a code when there is no row at all", async () => {
    // A PMS that was never seeded, or a fresh environment mid-migration.
    const { admin } = fakeAdmin({ row: null });
    expect(await pmsSignupCodeRequired(admin, "think")).toBe(true);
  });

  it("requires a code when the read itself fails", async () => {
    const { admin } = fakeAdmin({ selectError: "connection reset" });
    expect(await pmsSignupCodeRequired(admin, "cloudbeds")).toBe(true);
  });
});

describe("listPmsSignupGates", () => {
  it("returns every configured gate", async () => {
    const { admin } = fakeAdmin({
      rows: [
        { pms_type: "cloudbeds", requires_signup_code: false, updated_at: "2026-07-30T00:00:00Z" },
        { pms_type: "mews", requires_signup_code: true, updated_at: null },
      ],
    });
    const gates = await listPmsSignupGates(admin);
    expect(gates).toEqual([
      { pmsType: "cloudbeds", requiresSignupCode: false, updatedAt: "2026-07-30T00:00:00Z" },
      { pmsType: "mews", requiresSignupCode: true, updatedAt: null },
    ]);
  });

  it("throws on a read failure rather than silently returning nothing", async () => {
    // This one IS allowed to throw: it feeds the Command Center list page, and
    // an admin staring at an empty list with no error is worse than a page that
    // says loading failed.
    const { admin } = fakeAdmin({ selectError: "timeout" });
    await expect(listPmsSignupGates(admin)).rejects.toThrow(/timeout/);
  });
});

describe("setPmsSignupCodeRequired", () => {
  it("upserts the gate and logs who changed it", async () => {
    const { admin, upserts, logs } = fakeAdmin({});
    await setPmsSignupCodeRequired(admin, "cloudbeds", false, "user-1");
    expect(upserts[0]).toMatchObject({
      pms_type: "cloudbeds",
      requires_signup_code: false,
      updated_by: "user-1",
    });
    expect(logs[0]).toMatchObject({
      name: "platform_log_event",
      args: { p_entity_id: "cloudbeds", p_detail: { requires_signup_code: false } },
    });
  });

  it("throws on a write failure — the caller has to know the flip did not take", async () => {
    const { admin } = fakeAdmin({ upsertError: "constraint violation" });
    await expect(setPmsSignupCodeRequired(admin, "cloudbeds", false, "user-1")).rejects.toThrow(
      /constraint violation/,
    );
  });

  it("does not throw when only the audit log fails", async () => {
    // The gate change already landed; failing the request over the log would
    // leave an admin unsure whether their change took effect when it did.
    const { admin, upserts } = fakeAdmin({ logError: "log table full" });
    await expect(setPmsSignupCodeRequired(admin, "cloudbeds", false, "user-1")).resolves.toBeUndefined();
    expect(upserts).toHaveLength(1);
  });
});
