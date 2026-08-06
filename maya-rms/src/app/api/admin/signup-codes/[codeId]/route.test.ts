/**
 * Regression tests for turning a code off.
 *
 * The point of this route is that it is not a delete: signup_code_redemptions
 * cascades off a deleted code and hotel_subscriptions.signup_code_id nulls out,
 * so removing a row would erase the report the code exists to feed. These pin
 * that the row and its history survive, and that no DELETE handler creeps in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const state = vi.hoisted(() => ({
  isAdmin: true,
  codes: [] as Record<string, unknown>[],
  redemptions: [] as Record<string, unknown>[],
  events: [] as { type: unknown; entity: unknown }[],
}));

function fakeSsr() {
  return {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (col: string, val: unknown) => ({
          select: () => ({
            maybeSingle: async () => {
              const rows = table === "signup_codes" ? state.codes : state.redemptions;
              const row = rows.find((r) => r[col] === val);
              if (!row) return { data: null, error: null };
              Object.assign(row, patch);
              return { data: { id: row.id, code: row.code }, error: null };
            },
          }),
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

const routeModule = await import("./route");
const { PATCH } = routeModule;

function patch(body: unknown, codeId = "code-1") {
  return PATCH(
    new Request(`http://localhost/api/admin/signup-codes/${codeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ codeId }) },
  );
}

beforeEach(() => {
  state.isAdmin = true;
  state.codes = [{ id: "code-1", code: "DRIFTWOOD", is_active: true }];
  state.redemptions = [{ id: "r1", code_id: "code-1", email: "gm@driftwood.com" }];
  state.events = [];
});

describe("PATCH /api/admin/signup-codes/[codeId]", () => {
  it("turns a code off and keeps both the code and its redemptions", async () => {
    const res = await patch({ is_active: false });
    expect(res.status).toBe(200);
    expect(state.codes[0]).toMatchObject({ id: "code-1", is_active: false });
    expect(state.redemptions).toHaveLength(1);
  });

  it("turns one back on, for a code switched off by mistake", async () => {
    state.codes = [{ id: "code-1", code: "DRIFTWOOD", is_active: false }];
    const res = await patch({ is_active: true });
    expect(res.status).toBe(200);
    expect(state.codes[0]).toMatchObject({ is_active: true });
    expect(state.events).toEqual([{ type: "signup_code.reactivated", entity: "code-1" }]);
  });

  it("logs the deactivation against the code", async () => {
    await patch({ is_active: false });
    expect(state.events).toEqual([{ type: "signup_code.deactivated", entity: "code-1" }]);
  });

  it("refuses a body that doesn't say which way to flip it", async () => {
    for (const body of [{}, { is_active: "false" }, { is_active: null }]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
    }
    expect(state.codes[0]).toMatchObject({ is_active: true });
  });

  it("404s on a code that isn't there instead of reporting a silent success", async () => {
    const res = await patch({ is_active: false }, "code-nope");
    expect(res.status).toBe(404);
  });

  it("turns away anyone who isn't a platform admin", async () => {
    state.isAdmin = false;
    const res = await patch({ is_active: false });
    expect(res.status).toBe(403);
    expect(state.codes[0]).toMatchObject({ is_active: true });
  });

  it("exposes no way to delete a code", () => {
    expect("DELETE" in routeModule).toBe(false);
  });
});
