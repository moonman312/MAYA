/**
 * Changing or removing one person on the Team page: who may act on whom.
 *
 * A General Manager may change or remove anyone up to their own level, other
 * General Managers included, and never a Hotel Admin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const HOTEL = "hotel-1";

const state = vi.hoisted(() => ({
  actorIsAdmin: false,
  members: [] as { membershipId: string; userId: string; email: string; role: string; status: string }[],
  removeMembership: vi.fn(),
  setMembershipRole: vi.fn(),
  revokePendingInvite: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({}),
  isAdminConfigured: () => true,
}));
vi.mock("@/lib/require-supabase-hotel", () => ({
  requireSupabaseHotelRank: async () => ({ ok: true, hotelId: HOTEL, supabase: {} }),
  hasHotelRank: async () => state.actorIsAdmin,
}));
vi.mock("@/lib/account/team", () => ({
  loadTeam: async () => ({ members: state.members, invites: [{ pendingId: "pending-1", email: "x@y.z", role: "viewer", invitedAt: null }] }),
}));
vi.mock("@/lib/admin/memberships", () => ({
  removeMembership: state.removeMembership,
  setMembershipRole: state.setMembershipRole,
  revokePendingInvite: state.revokePendingInvite,
}));

const { DELETE, PATCH } = await import("./route");

const params = (memberId: string) => ({ params: Promise.resolve({ memberId }) });
const del = (memberId: string, kind?: string) =>
  DELETE(new Request(`https://maya.test/api/account/team/${memberId}${kind ? `?kind=${kind}` : ""}`, { method: "DELETE" }), params(memberId));
const patch = (memberId: string, role: string) =>
  PATCH(
    new Request(`https://maya.test/api/account/team/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    }),
    params(memberId),
  );

beforeEach(() => {
  state.actorIsAdmin = false;
  state.members = [
    { membershipId: "m-admin", userId: "u-admin", email: "owner@inn.example", role: "hotel_admin", status: "active" },
    { membershipId: "m-gm", userId: "u-gm", email: "gm@inn.example", role: "general_manager", status: "active" },
    { membershipId: "m-gm2", userId: "u-gm2", email: "gm2@inn.example", role: "general_manager", status: "active" },
  ];
  state.removeMembership.mockReset().mockResolvedValue(undefined);
  state.setMembershipRole.mockReset().mockResolvedValue(undefined);
  state.revokePendingInvite.mockReset().mockResolvedValue(undefined);
});

describe("a General Manager acting on the team", () => {
  it("may remove another General Manager", async () => {
    const res = await del("m-gm2");
    expect(res.status).toBe(200);
    expect(state.removeMembership).toHaveBeenCalledWith({}, { hotelId: HOTEL, userId: "u-gm2" });
  });

  it("may change another General Manager's role", async () => {
    const res = await patch("m-gm2", "revenue_manager");
    expect(res.status).toBe(200);
    expect(state.setMembershipRole).toHaveBeenCalledWith({}, { hotelId: HOTEL, userId: "u-gm2", role: "revenue_manager" });
  });

  it("may not remove a Hotel Admin", async () => {
    const res = await del("m-admin");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "That's above your own access level." });
    expect(state.removeMembership).not.toHaveBeenCalled();
  });
});
