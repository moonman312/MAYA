import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

/**
 * The hotel row a payment attaches to before a property exists.
 *
 * Payment happens before the PMS connect, and the PMS connect is what used to
 * create the hotel. But hotel_subscriptions is keyed by hotel_id and sync.ts
 * refuses a subscription whose metadata carries none — so a payment taken first
 * would have nothing to land on, and an unattachable payment is the worst thing
 * this flow can produce. Checkout therefore creates the row up front and the
 * connect callback adopts it, renaming it from the PMS.
 *
 * The row is marked with setup_pending_at and left is_active = false until then.
 * That second part is what keeps it invisible: listAccessibleHotels filters on
 * is_active, so nothing — property picker, dashboard, any sweep over live hotels
 * — sees a signup that never finished.
 */

/**
 * Placeholder name. hotels.name is globally unique and the real one only arrives
 * from the PMS on adoption, so this just has to not collide.
 */
function pendingName(): string {
  return `Pending setup ${randomUUID().slice(0, 8)}`;
}

/**
 * The caller's un-adopted hotel, if a previous checkout left one. Works with the
 * service-role client or the user's own — every filter here is scoped to their
 * memberships, which is exactly what RLS allows them to read anyway.
 */
export async function findPendingHotelForUser(
  client: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: memberships } = await client
    .from("hotel_memberships")
    .select("hotel_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (!memberships?.length) return null;

  const { data: pending } = await client
    .from("hotels")
    .select("id")
    .in(
      "id",
      memberships.map((m) => String(m.hotel_id)),
    )
    .not("setup_pending_at", "is", null);
  if (!pending?.length) return null;
  if (pending.length === 1) return String(pending[0].id);

  // Two rows means two checkouts raced (a double-click, two tabs). The one a
  // payment attached to is the one that matters: it is what the connect callback
  // must adopt, and what makes a second checkout report the subscription it
  // already has instead of selling them another.
  const ids = pending.map((h) => String(h.id));
  const { data: paid } = await client
    .from("hotel_subscriptions")
    .select("hotel_id")
    .in("hotel_id", ids)
    .limit(1)
    .maybeSingle();

  return paid ? String(paid.hotel_id) : ids[0];
}

export type PendingHotel = { ok: true; hotelId: string } | { ok: false; error: string };

/**
 * The row checkout will name in the subscription's metadata. Reuses an abandoned
 * one rather than stacking up a hotel per attempt, so a user who bounces off the
 * card form three times still owns exactly one.
 *
 * Service-role only: the caller has no membership yet, so nothing they could do
 * under RLS would let them create one.
 */
export async function provisionPendingHotel(
  admin: SupabaseClient,
  userId: string,
): Promise<PendingHotel> {
  const existing = await findPendingHotelForUser(admin, userId);
  if (existing) return { ok: true, hotelId: existing };

  const { data: hotel, error } = await admin
    .from("hotels")
    .insert({
      name: pendingName(),
      is_active: false,
      setup_pending_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !hotel) {
    return { ok: false, error: error?.message ?? "Could not create the property row." };
  }
  const hotelId = String(hotel.id);

  // Service role means auth.uid() is null, so the auto-membership trigger won't
  // fire — insert explicitly (same reason as lib/onboarding/connect.ts).
  const { error: memberErr } = await admin.from("hotel_memberships").insert({
    hotel_id: hotelId,
    user_id: userId,
    role: "hotel_admin",
    status: "active",
  });
  if (memberErr) {
    // A row nobody is a member of is unreachable by the person about to pay for
    // it, and the next attempt wouldn't find it either. Take it back out.
    await admin.from("hotels").delete().eq("id", hotelId);
    return { ok: false, error: memberErr.message };
  }

  return { ok: true, hotelId };
}
