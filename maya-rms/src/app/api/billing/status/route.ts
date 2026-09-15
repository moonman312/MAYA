import { headlineFor, loadAccountBilling } from "@/lib/billing/account";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * GET /api/billing/status — just enough for the dashboard banner to decide
 * whether to say anything.
 *
 * Deliberately readable by any member, not only the General Manager who can act
 * on it: everyone at a property whose pricing has stopped deserves to know why
 * it stopped, even if the person who fixes it is someone else. Nothing here
 * identifies a card or a customer.
 *
 * `?hotelId=` names a property outright. The active-hotel cookie only ever
 * points at a live property, and the post-checkout screen needs to watch a
 * parked one — the second property of a group, just paid for, not yet
 * activated by the webhook. The caller must hold an active membership on it;
 * RLS then decides what the read returns.
 */
export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("hotelId")?.trim() || null;
  const ctx = requested
    ? await requireNamedHotel(await cookies(), requested)
    : await requireSupabaseHotel(await cookies());
  if (!ctx.ok) return ctx.response;

  const billing = await loadAccountBilling(ctx.supabase, ctx.hotelId);
  // No subscription is not a billing problem — admin-created properties and
  // deployments without Stripe live here, and the banner must stay quiet.
  if (!billing) return NextResponse.json({ applicable: false });

  const headline = headlineFor(billing);
  return NextResponse.json({
    applicable: true,
    entitled: billing.entitled,
    tone: headline.tone,
    title: headline.title,
    detail: headline.detail,
  });
}

async function requireNamedHotel(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  hotelId: string,
): Promise<Awaited<ReturnType<typeof requireSupabaseHotel>>> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Supabase is not configured." }, { status: 503 }),
    };
  }
  const supabase = createClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  // Their own row only: the membership policy lets a member read a whole
  // hotel's list, so the user_id filter is what keeps this about the caller.
  const { data: membership } = await supabase
    .from("hotel_memberships")
    .select("hotel_id")
    .eq("hotel_id", hotelId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (!membership) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No access to that property." }, { status: 403 }),
    };
  }
  return { ok: true, supabase, hotelId };
}
