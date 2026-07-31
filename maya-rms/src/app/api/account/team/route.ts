import { loadTeam } from "@/lib/account/team";
import { inviteUserToHotel } from "@/lib/admin/memberships";
import { seatLimitMessage } from "@/lib/billing/seats";
import { enforceRateLimit } from "@/lib/rate-limit";
import { HOTEL_ROLES, type HotelRole } from "@/lib/roles";
import { hasHotelRank, requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The property's own team, managed by the property.
 *
 * Every membership change used to be platform-admin only, which meant a hotel
 * wanting to add its own night manager had to ask us — the single thing MAYA is
 * built to never require. The underlying functions are reused rather than
 * reimplemented; what changes is who may call them.
 *
 * General Manager and up, matching billing and the PMS connection
 * (canManageFinances in lib/roles.ts). Adding someone to a property is deciding
 * who can see and change its rates, which is the same weight of decision.
 */

/** Nobody may invite above their own rank. */
function canGrant(actor: HotelRole, granted: HotelRole): boolean {
  const rank = (r: HotelRole) => HOTEL_ROLES.find((x) => x.key === r)?.rank ?? 0;
  return rank(granted) <= rank(actor);
}

export async function GET() {
  const ctx = await requireSupabaseHotelRank(await cookies(), "general_manager");
  if (!ctx.ok) return ctx.response;
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Team management is not configured." }, { status: 503 });
  }

  try {
    return NextResponse.json(await loadTeam(createAdminClient(), ctx.hotelId));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load your team.";
    console.error(JSON.stringify({ fn: "teamGet", hotel: ctx.hotelId, error: message }));
    return NextResponse.json({ error: "Could not load your team." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const ctx = await requireSupabaseHotelRank(await cookies(), "general_manager");
  if (!ctx.ok) return ctx.response;
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Team management is not configured." }, { status: 503 });
  }

  let body: { email?: unknown; role?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Seats bound how many people can END UP on a property, not how many
  // invitation emails we send on its behalf — and the emails go out under our
  // sending domain, so the reputation being spent is ours.
  const throttled = await enforceRateLimit("invite", ctx.hotelId,
    "Too many invitations just now. Try again shortly.");
  if (throttled) return throttled;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = String(body.role ?? "") as HotelRole;
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!HOTEL_ROLES.some((r) => r.key === role)) {
    return NextResponse.json({ error: "Pick a role." }, { status: 400 });
  }

  // Rank ceiling. A General Manager handing out Hotel Admin would be granting
  // the one privilege they do not hold — including the right to remove them.
  const isAdmin = await hasHotelRank(ctx.supabase, ctx.hotelId, "hotel_admin");
  if (!canGrant(isAdmin ? "hotel_admin" : "general_manager", role)) {
    return NextResponse.json(
      { error: "You can't give someone a role above your own." },
      { status: 403 },
    );
  }

  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();
  const admin = createAdminClient();

  try {
    // Counted immediately before inviting rather than on the page that rendered
    // the form: two managers with the form open would otherwise both pass a
    // check made minutes ago and put the property one seat over.
    const team = await loadTeam(admin, ctx.hotelId);
    if (team.seats.full) {
      return NextResponse.json(
        { error: seatLimitMessage(team.rooms), reason: "seat_limit", seats: team.seats },
        { status: 409 },
      );
    }
    if (team.members.some((m) => m.email.toLowerCase() === email && m.status === "active")) {
      return NextResponse.json({ error: "That person is already on this property." }, { status: 409 });
    }
    if (team.invites.some((i) => i.email.toLowerCase() === email)) {
      return NextResponse.json({ error: "They already have an invitation pending." }, { status: 409 });
    }

    const result = await inviteUserToHotel(admin, {
      email,
      hotelId: ctx.hotelId,
      role,
      // Named in the invitation, so it reads as a colleague adding them rather
      // than an unexplained email from a product they have never heard of.
      inviterEmail: user?.email ?? null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not send that invitation.";
    console.error(JSON.stringify({ fn: "teamInvite", hotel: ctx.hotelId, error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
