/**
 * Regression tests for minting a code.
 *
 * Two things must hold: only a platform admin gets through (the redemption
 * report carries other customers' admin emails), and a malformed code comes back
 * as a sentence rather than as chk_signup_code_shape — the route validates the
 * same shape the constraint does, before the insert.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const state = vi.hoisted(() => ({
  isAdmin: true,
  inserted: null as Record<string, unknown> | null,
  insertError: null as { code?: string; message: string } | null,
  events: [] as { type: unknown; entity: unknown }[],
}));

function fakeSsr() {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            if (state.insertError) return { data: null, error: state.insertError };
            state.inserted = row;
            return { data: { id: "code-1", ...row }, error: null };
          },
        }),
      }),
    }),
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      state.events.push({ type: args.p_event_type, entity: args.p_entity_id });
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/admin/require-platform-admin", () => ({
  requirePlatformAdmin: async () =>
    state.isAdmin
      ? { ok: true, user: { id: "admin-1", email: "jake@mhs.test" }, ssr: fakeSsr(), admin: fakeSsr() }
      : { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) },
}));

const { POST } = await import("./route");

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/signup-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.isAdmin = true;
  state.inserted = null;
  state.insertError = null;
  state.events = [];
});

describe("POST /api/admin/signup-codes", () => {
  it("writes a trial code, attributed to whoever issued it", async () => {
    const res = await post({ code: "mhsfounder", kind: "trial", trial_days: 14, notes: "Corey's list" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; grants: string };
    expect(body.code).toBe("MHSFOUNDER");
    expect(body.grants).toContain("14 days free");
    expect(state.inserted).toMatchObject({
      code: "MHSFOUNDER",
      kind: "trial",
      trial_days: 14,
      percent_off: null,
      fixed_price_cents: null,
      notes: "Corey's list",
      created_by: "admin-1",
    });
  });

  it("records who minted it in the platform audit log", async () => {
    await post({ code: "MHSFOUNDER", kind: "trial", trial_days: 14 });
    expect(state.events).toEqual([{ type: "signup_code.created", entity: "code-1" }]);
  });

  it("answers a half-filled code in words, without touching the table", async () => {
    const res = await post({ code: "TWENTY", kind: "percent_off" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("chk_signup_code_shape");
    expect(body.error.toLowerCase()).toContain("percentage");
    expect(state.inserted).toBeNull();
  });

  it("refuses the retired fixed_price kind outright", async () => {
    // Every property pays its own bracket now; deals are discounts on top.
    const res = await post({ code: "AUSTINDEAL", kind: "fixed_price", tier_rooms_cap: 40 });
    expect(res.status).toBe(400);
    expect(state.inserted).toBeNull();
  });

  it("says a duplicate is a duplicate rather than quoting the unique index", async () => {
    state.insertError = { code: "23505", message: 'duplicate key value violates unique constraint "uq_signup_codes_code"' };
    const res = await post({ code: "MHSFOUNDER", kind: "trial", trial_days: 14 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already exists");
    expect(body.error).not.toContain("uq_signup_codes_code");
  });

  it("rejects a body that isn't JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/signup-codes", { method: "POST", body: "{" }),
    );
    expect(res.status).toBe(400);
    expect(state.inserted).toBeNull();
  });

  it("turns away anyone who isn't a platform admin", async () => {
    state.isAdmin = false;
    const res = await post({ code: "MHSFOUNDER", kind: "trial", trial_days: 14 });
    expect(res.status).toBe(403);
    expect(state.inserted).toBeNull();
  });
});
