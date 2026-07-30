import { headlineFor, loadAccountBilling } from "@/lib/billing/account";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
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
 */
export async function GET() {
  const ctx = await requireSupabaseHotel(await cookies());
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
