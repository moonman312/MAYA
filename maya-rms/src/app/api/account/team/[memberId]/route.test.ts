/**
 * Changing or removing one person on the Team page: who may act on whom.
 *
 * A General Manager may change or remove anyone up to their own level, other
 * General Managers included, and never a Hotel Admin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("when the change itself fails", () => {
  let logged: string[] = [];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a failed removal with a plain sentence and logs the detail", async () => {
    state.removeMembership.mockRejectedValue(new Error("platform_remove_membership: permission denied for table hotel_memberships"));
    const res = await del("m-gm2");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not remove them." });
    expect(logged.join("\n")).toContain("platform_remove_membership: permission denied");
  });

  it("answers a failed role change with a plain sentence and logs the detail", async () => {
    state.setMembershipRole.mockRejectedValue(new Error("platform_set_membership_role: JWT expired"));
    const res = await patch("m-gm2", "viewer");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not change that role." });
    expect(logged.join("\n")).toContain("platform_set_membership_role: JWT expired");
  });

  it("answers a failed cancellation with a plain sentence and logs the detail", async () => {
    state.revokePendingInvite.mockRejectedValue(new Error("platform_revoke_pending: Pending invite not found"));
    const res = await del("pending-1", "invite");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not cancel that invitation." });
    expect(logged.join("\n")).toContain("platform_revoke_pending");
  });
});
