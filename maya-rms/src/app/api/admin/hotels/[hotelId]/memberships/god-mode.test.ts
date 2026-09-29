/**
 * The Command Center's team edits on a property (invite, change a role,
 * remove) need God Mode: refused in plain words without a window, and each
 * recorded as support's change with one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({ godMode: true, db: null as unknown, calls: [] as { fn: string; input: unknown }[] }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/require-platform-admin", () => ({
  requirePlatformAdmin: async () => ({
    ok: true,
    user: { id: "admin-7", email: "jake@example.com" },
    ssr: { tag: "ssr" },
    admin: (state.db as ReturnType<typeof fakeSupabase>).client,
  }),
}));
vi.mock("@/lib/admin/god-mode", async () => {
  const real = await vi.importActual<typeof import("@/lib/admin/god-mode")>("@/lib/admin/god-mode");
  return {
    ...real,
    requireGodMode: async () =>
      state.godMode
        ? { ok: true, session: { id: "gm-1", startedAt: null, expiresAt: null } }
        : { ok: false, response: NextResponse.json({ error: real.GOD_MODE_OFF }, { status: 403 }) },
  };
});
vi.mock("@/lib/admin/memberships", () => ({
  inviteUserToHotel: async (_admin: unknown, input: { email: string }) => {
    state.calls.push({ fn: "invite", input });
    return { inviteSent: input.email !== "sam@example.com", pendingId: "pend-1", existingUser: input.email === "sam@example.com" };
  },
  setMembershipRole: async (_admin: unknown, input: unknown) => {
    state.calls.push({ fn: "setRole", input });
  },
  removeMembership: async (_admin: unknown, input: unknown) => {
    state.calls.push({ fn: "remove", input });
  },
}));

const invite = await import("./invite/route");
const member = await import("./[membershipId]/route");

const json = (method: string, body: unknown) =>
  new Request("http://localhost/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const inviteParams = { params: Promise.resolve({ hotelId: "hotel-1" }) };
const memberParams = { params: Promise.resolve({ hotelId: "hotel-1", membershipId: "m-1" }) };

beforeEach(() => {
  state.godMode = true;
  state.db = fakeSupabase();
  state.calls = [];
});

const changes = () => (state.db as ReturnType<typeof fakeSupabase>).tables.support_changes ?? [];

describe("Command Center team edits", () => {
  it("invites in God Mode and records it, naming the person and role", async () => {
    const res = await invite.POST(json("POST", { email: "Priya@Example.com", role: "revenue_manager" }), inviteParams);
    expect(res.status).toBe(200);
    expect(state.calls).toEqual([{ fn: "invite", input: expect.objectContaining({ email: "Priya@Example.com", hotelId: "hotel-1", role: "revenue_manager" }) }]);
    expect(changes()).toEqual([
      expect.objectContaining({ session_id: "gm-1", user_id: "admin-7", hotel_id: "hotel-1", table_name: "pending_memberships", row_id: "pend-1", op: "insert", summary: "Invited priya@example.com to the team as revenue manager." }),
    ]);
  });

  it("says added rather than invited for someone who already has a login", async () => {
    await invite.POST(json("POST", { email: "sam@example.com", role: "viewer" }), inviteParams);
    expect(changes()[0]).toMatchObject({ table_name: "hotel_memberships", summary: "Added sam@example.com to the team as viewer." });
  });

  it("changes and removes a role in God Mode, recording each", async () => {
    expect((await member.PATCH(json("PATCH", { userId: "u-2", role: "general_manager" }), memberParams)).status).toBe(200);
    expect((await member.DELETE(json("DELETE", { userId: "u-2" }), memberParams)).status).toBe(200);
    expect(state.calls).toEqual([
      { fn: "setRole", input: { hotelId: "hotel-1", userId: "u-2", role: "general_manager" } },
      { fn: "remove", input: { hotelId: "hotel-1", userId: "u-2" } },
    ]);
    expect(changes().map((c) => [c.table_name, c.row_id, c.op, c.summary])).toEqual([
      ["hotel_memberships", "m-1", "update", "Changed a team member's role to general manager."],
      ["hotel_memberships", "m-1", "delete", "Removed a team member."],
    ]);
  });

  it("refuses all three outside God Mode and changes nothing", async () => {
    state.godMode = false;
    const refused = [
      await invite.POST(json("POST", { email: "priya@example.com", role: "viewer" }), inviteParams),
      await member.PATCH(json("PATCH", { userId: "u-2", role: "viewer" }), memberParams),
      await member.DELETE(json("DELETE", { userId: "u-2" }), memberParams),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "God Mode is off. Turn it on from the Command Center to change this property." });
    }
    expect(state.calls).toEqual([]);
    expect(changes()).toEqual([]);
  });
});
