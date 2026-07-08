import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdminHotelUserRow,
  AdminPendingInviteRow,
  HotelRole,
} from "./types";

export async function listHotelMemberships(
  ssr: SupabaseClient,
  hotelId: string,
): Promise<AdminHotelUserRow[]> {
  const { data, error } = await ssr.rpc("platform_list_hotel_users", {
    p_hotel_id: hotelId,
  });
  if (error) throw new Error(`platform_list_hotel_users: ${error.message}`);
  return (data ?? []) as AdminHotelUserRow[];
}

export async function listPendingInvites(
  ssr: SupabaseClient,
  hotelId?: string,
): Promise<AdminPendingInviteRow[]> {
  const { data, error } = await ssr.rpc("platform_list_pending_invites", {
    p_hotel_id: hotelId ?? null,
  });
  if (error) throw new Error(`platform_list_pending_invites: ${error.message}`);
  return (data ?? []) as AdminPendingInviteRow[];
}

/**
 * Invites a user to a hotel end-to-end:
 *   1. Calls Supabase Auth admin API to send an invite email.
 *   2. Records the pending membership via platform_invite_user RPC.
 * If the email already exists in auth.users, step 1 is skipped and the RPC
 * materializes the membership directly.
 */
export async function inviteUserToHotel(
  admin: SupabaseClient,
  input: {
    email: string;
    hotelId: string;
    role: HotelRole;
  },
): Promise<{ inviteSent: boolean; pendingId: string; existingUser: boolean }> {
  const email = input.email.trim().toLowerCase();
  const redirectBase = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "");
  if (!redirectBase) {
    throw new Error(
      "MAYA_INVITE_REDIRECT_BASE is not configured; cannot construct invite redirect URL.",
    );
  }

  // Check if the user already exists to decide whether to send an invite email.
  const { data: existing, error: lookupErr } = await admin
    .from("platform_users_view")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (lookupErr && lookupErr.code !== "PGRST116") {
    throw new Error(`User lookup failed: ${lookupErr.message}`);
  }
  const existingUser = Boolean(existing?.id);

  let supabaseInviteId: string | null = null;
  if (!existingUser) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${redirectBase}/auth/accept-invite`,
    });
    if (error) {
      throw new Error(`Supabase Auth invite failed: ${error.message}`);
    }
    supabaseInviteId = data.user?.id ?? null;
  }

  const { data: pendingId, error: rpcErr } = await admin.rpc("platform_invite_user", {
    p_email: email,
    p_hotel_id: input.hotelId,
    p_role: input.role,
    p_supabase_invite_id: supabaseInviteId,
  });
  if (rpcErr) {
    throw new Error(`platform_invite_user: ${rpcErr.message}`);
  }

  return {
    inviteSent: !existingUser,
    pendingId: String(pendingId),
    existingUser,
  };
}

export async function setMembershipRole(
  admin: SupabaseClient,
  input: { hotelId: string; userId: string; role: HotelRole },
): Promise<void> {
  const { error } = await admin.rpc("platform_set_membership_role", {
    p_hotel_id: input.hotelId,
    p_user_id: input.userId,
    p_role: input.role,
  });
  if (error) throw new Error(`platform_set_membership_role: ${error.message}`);
}

export async function removeMembership(
  admin: SupabaseClient,
  input: { hotelId: string; userId: string },
): Promise<void> {
  const { error } = await admin.rpc("platform_remove_membership", {
    p_hotel_id: input.hotelId,
    p_user_id: input.userId,
  });
  if (error) throw new Error(`platform_remove_membership: ${error.message}`);
}

export async function revokePendingInvite(
  admin: SupabaseClient,
  pendingId: string,
): Promise<void> {
  const { error } = await admin.rpc("platform_revoke_pending", {
    p_pending_id: pendingId,
  });
  if (error) throw new Error(`platform_revoke_pending: ${error.message}`);
}

/**
 * Re-sends the Supabase Auth invite email for a pending invitation. Does not
 * modify pending_memberships.
 */
export async function resendInviteEmail(
  admin: SupabaseClient,
  email: string,
): Promise<void> {
  const redirectBase = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "");
  if (!redirectBase) {
    throw new Error(
      "MAYA_INVITE_REDIRECT_BASE is not configured; cannot construct invite redirect URL.",
    );
  }
  const { error } = await admin.auth.admin.inviteUserByEmail(email.toLowerCase(), {
    redirectTo: `${redirectBase}/auth/accept-invite`,
  });
  if (error) throw new Error(`Resend invite failed: ${error.message}`);
}
