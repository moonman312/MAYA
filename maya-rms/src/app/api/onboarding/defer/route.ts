/**
 * /api/onboarding/defer — "Not now" for a parked Marketplace property.
 *
 * A group grant parks one hotel per property and /onboarding walks the owner
 * through paying for each. POST here marks one as deferred so the queue skips
 * it and the owner gets on with the properties they do want live; DELETE
 * clears the mark so /onboarding offers it again (the billing page's "Set up").
 *
 * The gate is an active membership at General Manager or above — the same
 * bar checkout holds for paying for this hotel, because both are decisions
 * about the billing queue. (Nothing stops an admin inviting a viewer to a
 * parked property, so membership alone is not the whole story.) Everything
 * else checked here is about the HOTEL: it has to still be parked, be one a
 * redeemed Marketplace claim points at (Flow B's placeholder is not this),
 * and not already be paid for. Deferring a live or paid property would mean
 * nothing and hide it from the wrong list, so both answer 409.
 *
 * "Not now" also needs somewhere else to go. The onboarding page only offers
 * it while another sibling is waiting or a property is live, but a stale tab
 * can still POST for the last one; the route re-checks and answers 409, or
 * the owner would land on the plain subscribe screen with no way back to the
 * billing page that lists deferred properties.
 *
 * Every change is audited: the flag decides whether a property gets billed.
 */

import { isUuid } from "@/lib/api-guards";
import { isEntitledStatus } from "@/lib/billing/entitlement";
import { listUnpaidMarketplaceHotels } from "@/lib/billing/pending-hotel";
import { roleLabel, roleRank } from "@/lib/roles";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Gate =
  | { ok: true; userId: string; hotelId: string; admin: SupabaseClient }
  | { ok: false; response: NextResponse };

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

async function readHotelId(req: Request): Promise<unknown> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as { hotelId?: unknown }).hotelId : undefined;
  } catch {
    return undefined;
  }
}

/** PostgREST's "column does not exist": the migration has not run here yet. */
function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === "42703" || (error.message ?? "").includes("setup_deferred")));
}

/**
 * Sign-in, a well-formed id, the service role, and then the hotel itself.
 * Membership is read on the admin client for the same reason the rest of the
 * Marketplace queue is: the claim table it has to cross-check is not readable
 * by members.
 */
async function gate(req: Request): Promise<Gate> {
  if (!isSupabaseConfigured()) return { ok: false, response: fail(501, "Supabase is required for this.") };

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: fail(401, "Unauthorized") };

  const hotelId = await readHotelId(req);
  if (typeof hotelId !== "string" || !isUuid(hotelId)) {
    return { ok: false, response: fail(400, "Pick a property first.") };
  }

  if (!isAdminConfigured()) {
    return { ok: false, response: fail(503, "This needs SUPABASE_SERVICE_ROLE_KEY set on the server.") };
  }
  const admin = createAdminClient();

  const { data: membership, error: memberErr } = await admin
    .from("hotel_memberships")
    .select("hotel_id, role")
    .eq("hotel_id", hotelId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (memberErr) throw new Error(`Could not read memberships: ${memberErr.message}`);
  if (!membership) return { ok: false, response: fail(403, "That property isn't yours.") };
  if (roleRank(String(membership.role ?? "")) < roleRank("general_manager")) {
    return {
      ok: false,
      response: fail(403, `This needs ${roleLabel("general_manager")} access or higher on this property.`),
    };
  }

  const { data: hotel, error: hotelErr } = await admin
    .from("hotels")
    .select("id, is_active, setup_pending_at")
    .eq("id", hotelId)
    .maybeSingle();
  if (hotelErr) throw new Error(`Could not read the property: ${hotelErr.message}`);
  if (!hotel) return { ok: false, response: fail(404, "That property no longer exists.") };
  if (hotel.is_active === true || hotel.setup_pending_at == null) {
    return { ok: false, response: fail(409, "This property is already set up.") };
  }

  const { data: claim, error: claimErr } = await admin
    .from("pms_marketplace_claims")
    .select("hotel_id")
    .eq("hotel_id", hotelId)
    .not("claimed_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (claimErr) throw new Error(`Could not read Marketplace claims: ${claimErr.message}`);
  if (!claim) {
    return { ok: false, response: fail(409, "This property isn't waiting on a Marketplace setup.") };
  }

  const { data: subs, error: subsErr } = await admin
    .from("hotel_subscriptions")
    .select("status")
    .eq("hotel_id", hotelId);
  if (subsErr) throw new Error(`Could not read subscriptions: ${subsErr.message}`);
  if ((subs ?? []).some((s) => isEntitledStatus(s.status == null ? null : String(s.status)))) {
    return { ok: false, response: fail(409, "This property is already paid for.") };
  }

  return { ok: true, userId: user.id, hotelId, admin };
}

async function setDeferred(req: Request, deferred: boolean): Promise<NextResponse> {
  try {
    const gated = await gate(req);
    if (!gated.ok) return gated.response;
    const { userId, hotelId, admin } = gated;

    if (deferred && !(await somewhereElseToGo(admin, userId, hotelId))) {
      return fail(409, "This is the only property left to set up.");
    }

    const now = new Date().toISOString();
    const { error } = await admin
      .from("hotels")
      .update(
        deferred
          ? { setup_deferred_at: now, setup_deferred_by: userId }
          : { setup_deferred_at: null, setup_deferred_by: null },
      )
      .eq("id", hotelId);
    if (error) {
      if (isMissingColumn(error)) {
        // Deployed ahead of its migration. The queue is still offering this
        // property, so nothing is lost by refusing; it just cannot be skipped yet.
        console.error(
          JSON.stringify({
            fn: "onboarding/defer",
            hotelId,
            warning: "hotels.setup_deferred_at is missing — run 99_supabase_migration_setup_deferred_v1.sql",
          }),
        );
        return fail(503, "This needs a database update first.");
      }
      throw new Error(`Could not update the property: ${error.message}`);
    }

    // actor_user_id, the key every service-role audit line uses for the real
    // actor (auth.uid() is null here), so one query answers "who".
    const { error: logErr } = await admin.rpc("platform_log_event", {
      p_event_type: deferred ? "pms.marketplace_deferred" : "pms.marketplace_resumed",
      p_entity_type: "hotel",
      p_entity_id: hotelId,
      p_hotel_id: hotelId,
      p_detail: { actor_user_id: userId, via: "onboarding_not_now" },
    });
    if (logErr) {
      // The flag is set; a missing audit line is worth a log, not a failed request.
      console.error(
        JSON.stringify({ fn: "onboarding/defer", step: "audit", hotelId, error: logErr.message }),
      );
    }

    return NextResponse.json({ ok: true, hotelId, deferred });
  } catch (error) {
    console.error(
      JSON.stringify({
        fn: "onboarding/defer",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return fail(500, "Something went wrong on our side. Try again in a moment.");
  }
}

/**
 * Another unpaid sibling still in the queue, or a live property the owner can
 * open. Without one of those, deferring this hotel leaves /onboarding with
 * nothing to offer and /account/billing with no property to render, so the
 * "Set up" list that undoes the deferral is unreachable.
 */
async function somewhereElseToGo(admin: SupabaseClient, userId: string, hotelId: string): Promise<boolean> {
  const unpaid = await listUnpaidMarketplaceHotels(admin, userId);
  if (unpaid.some((h) => h.hotelId !== hotelId)) return true;

  const { data: memberships, error: memberErr } = await admin
    .from("hotel_memberships")
    .select("hotel_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (memberErr) throw new Error(`Could not read memberships: ${memberErr.message}`);
  const ids = (memberships ?? []).map((m) => String(m.hotel_id)).filter((id) => id !== hotelId);
  if (ids.length === 0) return false;

  const { data: live, error: liveErr } = await admin
    .from("hotels")
    .select("id")
    .in("id", ids)
    .eq("is_active", true)
    .limit(1);
  if (liveErr) throw new Error(`Could not read the properties: ${liveErr.message}`);
  return (live ?? []).length > 0;
}

export async function POST(req: Request) {
  return setDeferred(req, true);
}

export async function DELETE(req: Request) {
  return setDeferred(req, false);
}
