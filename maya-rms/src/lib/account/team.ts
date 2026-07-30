import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listHotelMemberships } from "@/lib/admin/memberships";
import { seatUsage, type SeatUsage } from "@/lib/billing/seats";

/**
 * The team on a property, as its own owner sees it.
 *
 * A thin layer over the platform-admin membership functions rather than a second
 * implementation of them: the queries are identical, only who is allowed to run
 * them differs, and two versions of "who is on this hotel" would eventually
 * disagree about who can see a rate.
 *
 * The seat count comes from the BILLED room count, not the measured one. What
 * they pay for is what they get — and billed_rooms is the number they control,
 * so a seat cannot vanish because a room type was deactivated overnight.
 */

export type TeamMember = {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  status: string;
  createdAt: string | null;
};

export type TeamInvite = {
  pendingId: string;
  email: string;
  role: string;
  invitedAt: string | null;
};

export type TeamView = {
  members: TeamMember[];
  invites: TeamInvite[];
  seats: SeatUsage;
  /** Billed rooms, so the seat limit can be explained in terms of the plan. */
  rooms: number;
};

export async function loadTeam(
  admin: SupabaseClient,
  hotelId: string,
): Promise<TeamView> {
  const [rawMembers, rawInvites, sub] = await Promise.all([
    // platform_list_hotel_users already allows can_manage_hotel, so the database
    // agrees this caller may see the list.
    listHotelMemberships(admin, hotelId),
    // Read directly rather than through platform_list_pending_invites, which is
    // platform-admin only and has no can_manage_hotel escape. Widening that RPC
    // would mean another migration for one query; the route above this has
    // already established the caller is a General Manager on THIS hotel, and the
    // filter is scoped to it.
    admin
      .from("pending_memberships")
      .select("id, email, role, invited_at")
      .eq("hotel_id", hotelId)
      .eq("status", "pending")
      .order("invited_at", { ascending: false }),
    admin.from("hotel_subscriptions").select("billed_rooms").eq("hotel_id", hotelId).maybeSingle(),
  ]);

  const members: TeamMember[] = (rawMembers ?? []).map((m) => ({
    membershipId: String(m.membership_id),
    userId: String(m.user_id),
    email: String(m.email ?? "unknown"),
    role: String(m.role),
    status: String(m.status),
    createdAt: m.created_at ? String(m.created_at) : null,
  }));

  const invites: TeamInvite[] = (rawInvites.data ?? []).map((p) => ({
    pendingId: String(p.id),
    email: String(p.email),
    role: String(p.role),
    invitedAt: p.invited_at ? String(p.invited_at) : null,
  }));

  const active = members.filter((m) => m.status === "active").length;

  // A property with NO subscription is not on a plan, so there is no plan limit
  // to apply — the sandbox, anything an admin created by hand, and every
  // deployment without Stripe. Same rule splitByEntitlement follows for the same
  // reason: the absence of billing must not read as the smallest billing.
  if (!sub.data) {
    return {
      members,
      invites,
      seats: { used: active + invites.length, limit: Infinity, remaining: Infinity, full: false },
      rooms: 0,
    };
  }

  const rooms = Number(sub.data.billed_rooms) || 0;
  return { members, invites, seats: seatUsage(rooms, active, invites.length), rooms };
}
