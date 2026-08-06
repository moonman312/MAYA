import { requireEntitledHotel } from "@/lib/billing/require-entitled";
import { requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { isStripeConfigured, stripeClient } from "@/lib/billing/stripe";
import { isBillableRoomCount, MAX_ROOMS } from "@/lib/billing/tiers";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * PATCH /api/billing/rooms — change how many rooms this property is billed for.
 *
 * Properties open a wing and close a floor, and a hotel that cannot correct its
 * own room count either overpays quietly or calls someone — both of which this
 * product exists to avoid.
 *
 * The count is a QUANTITY against a Stripe price we own; no amount is ever sent
 * from the client, so the worst a tampered request can do is set a room count,
 * which the brackets then price. Stripe works out the proration, and the change
 * comes back through the webhook — this route never writes the local row itself,
 * which is what keeps one source of truth for what is billed.
 */
export async function PATCH(req: Request) {
  // Same bar as the portal: billing is General Manager and up.
  const ctx = await requireSupabaseHotelRank(await cookies(), "general_manager");
  if (!ctx.ok) return ctx.response;

  // A lapsed subscription has no live item to re-quantify, and letting someone
  // "fix" their room count instead of their payment would be a dead end.
  const paid = await requireEntitledHotel(ctx.supabase, ctx.hotelId);
  if (!paid.ok) return paid.response;

  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing is not configured on this deployment." }, { status: 503 });
  }

  let rooms: unknown;
  try {
    ({ rooms } = (await req.json()) as { rooms?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isBillableRoomCount(rooms)) {
    return NextResponse.json(
      { error: `Enter a whole number of rooms between 1 and ${MAX_ROOMS}.` },
      { status: 400 },
    );
  }

  const { data: sub } = await ctx.supabase
    .from("hotel_subscriptions")
    .select("stripe_subscription_id, billed_rooms")
    .eq("hotel_id", ctx.hotelId)
    .maybeSingle();

  if (!sub?.stripe_subscription_id) {
    return NextResponse.json({ error: "This property has no subscription to change." }, { status: 404 });
  }
  if (Number(sub.billed_rooms) === rooms) {
    return NextResponse.json({ ok: true, rooms, unchanged: true });
  }

  try {
    const stripe = stripeClient();
    // Re-read from Stripe rather than trusting our copy of the item id, for the
    // same reason the webhook re-fetches: our row can be a delivery behind.
    const live = await stripe.subscriptions.retrieve(String(sub.stripe_subscription_id));
    const item = live.items.data[0];
    if (!item) {
      return NextResponse.json({ error: "This subscription has nothing to change." }, { status: 409 });
    }

    await stripe.subscriptions.update(String(sub.stripe_subscription_id), {
      items: [{ id: item.id, quantity: rooms }],
      // Credit the unused part of what they already paid and charge the
      // difference on the next invoice, rather than billing immediately — a
      // surprise mid-month charge for adding a room is how you teach someone
      // never to touch this screen again.
      proration_behavior: "create_prorations",
    });

    return NextResponse.json({ ok: true, rooms });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not change the room count.";
    console.error(JSON.stringify({ fn: "changeRooms", hotel: ctx.hotelId, rooms, error: message }));
    return NextResponse.json({ error: "Could not change the room count. Try again shortly." }, { status: 502 });
  }
}
