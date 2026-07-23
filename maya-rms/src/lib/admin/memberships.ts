import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  inviteEmailHtml,
  inviteEmailSubject,
  inviteEmailText,
  type InviteEmailInput,
} from "@/lib/email/invite-email";
import { sendEmail } from "@/lib/email/resend";
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
 * Metadata stored on the Supabase Auth user at invite time. No longer used
 * by an email template (emails are rendered in-app and sent via Resend), but
 * kept on the user record for auditability.
 */
export type InviteMetadata = {
  hotel_name: string;
  role: HotelRole;
  inviter_email: string | null;
};

function requireRedirectBase(): string {
  const redirectBase = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "");
  if (!redirectBase) {
    throw new Error(
      "MAYA_INVITE_REDIRECT_BASE is not configured; cannot construct invite redirect URL.",
    );
  }
  return redirectBase;
}

/**
 * Generates a Supabase Auth invite link WITHOUT sending Supabase's email
 * (we send our own through Resend). Returns a link to our /auth/accept-invite
 * page carrying the token hash, which the page redeems via verifyOtp.
 *
 * If the address already belongs to a registered (confirmed) user — e.g. an
 * admin hits "Resend" after the user accepted, or the user belongs to another
 * hotel — `type: "invite"` is rejected by Supabase, so we fall back to a
 * magic link. Clicking it signs the user in and lands on the same page.
 */
async function generateAcceptInviteLink(
  admin: SupabaseClient,
  email: string,
  metadata: InviteMetadata,
): Promise<{ acceptUrl: string; userId: string | null }> {
  const redirectBase = requireRedirectBase();
  const redirectTo = `${redirectBase}/auth/accept-invite`;

  let { data, error } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { redirectTo, data: metadata },
  });

  if (
    error &&
    (error.code === "email_exists" ||
      /already.*registered/i.test(error.message))
  ) {
    ({ data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    }));
  }
  if (error) {
    throw new Error(`Supabase invite link generation failed: ${error.message}`);
  }

  const tokenHash = data.properties?.hashed_token;
  const verificationType = data.properties?.verification_type;
  if (!tokenHash || !verificationType) {
    throw new Error("Supabase returned no invite token; cannot build accept link.");
  }

  const acceptUrl =
    `${redirectTo}?token_hash=${encodeURIComponent(tokenHash)}` +
    `&type=${encodeURIComponent(verificationType)}`;
  return { acceptUrl, userId: data.user?.id ?? null };
}

async function sendInviteEmail(to: string, input: InviteEmailInput): Promise<void> {
  await sendEmail({
    to,
    subject: inviteEmailSubject(input),
    html: inviteEmailHtml(input),
    text: inviteEmailText(input),
    ...(input.inviterEmail ? { replyTo: input.inviterEmail } : {}),
  });
}

/**
 * Invites a user to a hotel end-to-end:
 *   1. Generates a Supabase Auth invite link (no Supabase email) and sends
 *      our own invite email through Resend.
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
    inviterEmail?: string | null;
  },
): Promise<{ inviteSent: boolean; pendingId: string; existingUser: boolean }> {
  const email = input.email.trim().toLowerCase();

  // Look up the hotel name so the invite email can address it directly.
  const { data: hotelRow, error: hotelLookupErr } = await admin
    .from("hotels")
    .select("name")
    .eq("id", input.hotelId)
    .maybeSingle();
  if (hotelLookupErr) {
    throw new Error(`Hotel lookup failed: ${hotelLookupErr.message}`);
  }
  const hotelName = hotelRow?.name ?? "your hotel";

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

  const metadata: InviteMetadata = {
    hotel_name: hotelName,
    role: input.role,
    inviter_email: input.inviterEmail ?? null,
  };

  let supabaseInviteId: string | null = null;
  if (!existingUser) {
    const { acceptUrl, userId } = await generateAcceptInviteLink(
      admin,
      email,
      metadata,
    );
    await sendInviteEmail(email, {
      acceptUrl,
      hotelName,
      role: input.role,
      inviterEmail: input.inviterEmail ?? null,
    });
    supabaseInviteId = userId;
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
 * Re-sends the invite email for a pending invitation: regenerates a fresh
 * Supabase Auth link and sends a new Resend email with the original hotel,
 * role, and inviter context re-hydrated from the pending_memberships row.
 */
export async function resendInviteEmail(
  admin: SupabaseClient,
  email: string,
  opts?: { inviterEmail?: string | null },
): Promise<void> {
  const normalized = email.trim().toLowerCase();

  // Look up the pending invite to grab the original hotel + role for the email.
  const { data: pending, error: pmErr } = await admin
    .from("pending_memberships")
    .select("hotel_id, role")
    .eq("email", normalized)
    .eq("status", "pending")
    .order("invited_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pmErr) throw new Error(`Pending invite lookup failed: ${pmErr.message}`);

  let hotelName = "your hotel";
  let role: HotelRole = "viewer";
  if (pending) {
    const { data: hotelRow } = await admin
      .from("hotels")
      .select("name")
      .eq("id", pending.hotel_id)
      .maybeSingle();
    hotelName = hotelRow?.name ?? "your hotel";
    role = pending.role as HotelRole;
  }

  const metadata: InviteMetadata = {
    hotel_name: hotelName,
    role,
    inviter_email: opts?.inviterEmail ?? null,
  };

  try {
    const { acceptUrl } = await generateAcceptInviteLink(admin, normalized, metadata);
    await sendInviteEmail(normalized, {
      acceptUrl,
      hotelName,
      role,
      inviterEmail: opts?.inviterEmail ?? null,
      isResend: true,
    });
  } catch (error) {
    throw new Error(
      `Resend invite failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
