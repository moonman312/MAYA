import { loadTeam } from "@/lib/account/team";
import { removeMembership, revokePendingInvite, setMembershipRole } from "@/lib/admin/memberships";
import { HOTEL_ROLES, type HotelRole } from "@/lib/roles";
import { hasHotelRank, requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Changing or removing one person.
 *
 * The id in the path is checked against THIS hotel's team before anything acts
 * on it. The underlying functions take an id and do as they are told, so without
 * that check a General Manager at one property could pass a membership id from
 * another and remove a stranger.
 */

type Ctx = { params: Promise<{ memberId: string }> };

const rankOf = (r: string) => HOTEL_ROLES.find((x) => x.key === r)?.rank ?? 0;

export async function PATCH(request: Request, { params }: Ctx) {
  const ctx = await requireSupabaseHotelRank(await cookies(), "general_manager");
  if (!ctx.ok) return ctx.response;
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Team management is not configured." }, { status: 503 });
  }

  const { memberId } = await params;
  let role: HotelRole;
  try {
    role = String(((await request.json()) as { role?: unknown }).role ?? "") as HotelRole;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!HOTEL_ROLES.some((r) => r.key === role)) {
    return NextResponse.json({ error: "Pick a role." }, { status: 400 });
  }

  const admin = createAdminClient();
  const team = await loadTeam(admin, ctx.hotelId);
  const member = team.members.find((m) => m.membershipId === memberId);
  if (!member) {
    return NextResponse.json({ error: "That person isn't on this property." }, { status: 404 });
  }

  const ceiling: HotelRole = (await hasHotelRank(ctx.supabase, ctx.hotelId, "hotel_admin"))
    ? "hotel_admin"
    : "general_manager";
  // Both directions: you may not promote someone above yourself, and you may not
  // demote someone who already outranks you.
  if (rankOf(role) > rankOf(ceiling) || rankOf(member.role) > rankOf(ceiling)) {
    return NextResponse.json({ error: "That's above your own access level." }, { status: 403 });
  }

  // The last way in must stay open. Demoting the only Hotel Admin leaves a
  // property nobody can add people to, change billing on, or delete — a state
  // only we could unpick.
  if (member.role === "hotel_admin" && role !== "hotel_admin") {
    const admins = team.members.filter((m) => m.role === "hotel_admin" && m.status === "active");
    if (admins.length <= 1) {
      return NextResponse.json(
        { error: "This is the property's only Hotel Admin. Make someone else one first." },
        { status: 409 },
      );
    }
  }

  try {
    // hotelId comes from the session, not the request — the id in the path
    // only ever selects WHICH member, never which property.
    await setMembershipRole(admin, { hotelId: ctx.hotelId, userId: member.userId, role });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not change that role.";
    console.error(JSON.stringify({ fn: "teamPatch", hotel: ctx.hotelId, error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  const ctx = await requireSupabaseHotelRank(await cookies(), "general_manager");
  if (!ctx.ok) return ctx.response;
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Team management is not configured." }, { status: 503 });
  }

  const { memberId } = await params;
  const kind = new URL(request.url).searchParams.get("kind");
  const admin = createAdminClient();
  const team = await loadTeam(admin, ctx.hotelId);

  // An invitation that has not been accepted is a different row in a different
  // table, and the client says which it means.
  if (kind === "invite") {
    if (!team.invites.some((i) => i.pendingId === memberId)) {
      return NextResponse.json({ error: "That invitation isn't on this property." }, { status: 404 });
    }
    try {
      await revokePendingInvite(admin, memberId);
      return NextResponse.json({ ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not cancel that invitation.";
      console.error(JSON.stringify({ fn: "teamRevoke", hotel: ctx.hotelId, error: message }));
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const member = team.members.find((m) => m.membershipId === memberId);
  if (!member) {
    return NextResponse.json({ error: "That person isn't on this property." }, { status: 404 });
  }

  const ceiling: HotelRole = (await hasHotelRank(ctx.supabase, ctx.hotelId, "hotel_admin"))
    ? "hotel_admin"
    : "general_manager";
  if (rankOf(member.role) > rankOf(ceiling)) {
    return NextResponse.json({ error: "That's above your own access level." }, { status: 403 });
  }

  if (member.role === "hotel_admin") {
    const admins = team.members.filter((m) => m.role === "hotel_admin" && m.status === "active");
    if (admins.length <= 1) {
      return NextResponse.json(
        { error: "This is the property's only Hotel Admin. Make someone else one first." },
        { status: 409 },
      );
    }
  }

  try {
    await removeMembership(admin, { hotelId: ctx.hotelId, userId: member.userId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not remove them.";
    console.error(JSON.stringify({ fn: "teamDelete", hotel: ctx.hotelId, error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
