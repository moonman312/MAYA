import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { isEntitledStatus } from "@/lib/billing/entitlement";

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
  const { data: memberships, error: membershipErr } = await client
    .from("hotel_memberships")
    .select("hotel_id")
    .eq("user_id", userId)
    .eq("status", "active");
  // A failed read is not "they have no pending hotel". Answering null on an
  // error made provisionPendingHotel create a SECOND row beside the one the
  // customer had already paid against, and left the connect callback unable to
  // find the first — orphaning a live subscription. Throwing makes the caller
  // fail visibly instead of quietly doing the wrong thing.
  if (membershipErr) throw new Error(`Could not read memberships: ${membershipErr.message}`);
  if (!memberships?.length) return null;

  // Ordered so two callers looking at the same pair of rows name the same one:
  // a group grant parks several at once, and ids[0] off an unordered read could
  // send checkout and the connect callback to different hotels.
  const { data: pending, error: pendingErr } = await client
    .from("hotels")
    .select("id")
    .in(
      "id",
      memberships.map((m) => String(m.hotel_id)),
    )
    .not("setup_pending_at", "is", null)
    .order("created_at", { ascending: true });
  if (pendingErr) throw new Error(`Could not read pending properties: ${pendingErr.message}`);
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

export type UnpaidMarketplaceHotel = {
  hotelId: string;
  /** The hotels.name the callback gave it — already the PMS name. */
  name: string;
  /** What the claim ticket called it, when the ticket carried a name. */
  propertyName: string | null;
  pmsType: string;
  /** Ties the properties of one group grant together; null for a lone property. */
  groupKey: string | null;
};

/**
 * The caller's Marketplace properties that are owned but not yet paid for,
 * oldest first (then by name).
 *
 * A group grant parks one hotel per property and the claim hands the owner all
 * of them at once, but a subscription is per hotel, so they are paid for one
 * at a time. This is the queue: what a redeemed claim points at, still parked,
 * with no live subscription. The claim row is what separates these from Flow
 * B's placeholder, which has the same shape and must be left to the PMS connect.
 *
 * Service-role client: pms_marketplace_claims is not readable by members.
 */
export async function listUnpaidMarketplaceHotels(
  admin: SupabaseClient,
  userId: string,
): Promise<UnpaidMarketplaceHotel[]> {
  const { data: memberships, error: membershipErr } = await admin
    .from("hotel_memberships")
    .select("hotel_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (membershipErr) throw new Error(`Could not read memberships: ${membershipErr.message}`);
  if (!memberships?.length) return [];

  const { data: hotels, error: hotelsErr } = await admin
    .from("hotels")
    .select("id, name, created_at")
    .in(
      "id",
      memberships.map((m) => String(m.hotel_id)),
    )
    .not("setup_pending_at", "is", null)
    .eq("is_active", false)
    .order("created_at", { ascending: true })
    .order("name", { ascending: true });
  if (hotelsErr) throw new Error(`Could not read pending properties: ${hotelsErr.message}`);
  if (!hotels?.length) return [];
  const hotelIds = hotels.map((h) => String(h.id));

  // group_key arrives in its own migration and selecting a column that does not
  // exist is a hard PostgREST error, so the read falls back and loses only the
  // grouping (same as marketplace-claim.ts).
  type ClaimRow = { hotel_id: string; property_name: string | null; pms_type: string; group_key?: string | null };
  let claims: ClaimRow[] | null = null;
  const withGroup = await admin
    .from("pms_marketplace_claims")
    .select("hotel_id, property_name, pms_type, group_key")
    .in("hotel_id", hotelIds)
    .not("claimed_at", "is", null);
  if (!withGroup.error) {
    claims = (withGroup.data ?? []) as ClaimRow[];
  } else {
    const plain = await admin
      .from("pms_marketplace_claims")
      .select("hotel_id, property_name, pms_type")
      .in("hotel_id", hotelIds)
      .not("claimed_at", "is", null);
    if (plain.error) throw new Error(`Could not read Marketplace claims: ${plain.error.message}`);
    claims = (plain.data ?? []) as ClaimRow[];
  }
  const claimByHotel = new Map(claims.map((c) => [String(c.hotel_id), c]));
  if (claimByHotel.size === 0) return [];

  const { data: subs, error: subsErr } = await admin
    .from("hotel_subscriptions")
    .select("hotel_id, status")
    .in("hotel_id", [...claimByHotel.keys()]);
  if (subsErr) throw new Error(`Could not read subscriptions: ${subsErr.message}`);
  const paid = new Set(
    (subs ?? [])
      .filter((s) => isEntitledStatus(s.status == null ? null : String(s.status)))
      .map((s) => String(s.hotel_id)),
  );

  // Sorted here as well as in the query so the contract holds whatever the
  // client underneath does with order().
  const byAge = (a: { created_at?: unknown; name?: unknown }, b: { created_at?: unknown; name?: unknown }) =>
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
    String(a.name ?? "").localeCompare(String(b.name ?? ""));

  return [...hotels]
    .sort(byAge)
    .flatMap((h) => {
      const id = String(h.id);
      const claim = claimByHotel.get(id);
      if (!claim || paid.has(id)) return [];
      return [
        {
          hotelId: id,
          name: String(h.name ?? ""),
          propertyName: claim.property_name == null ? null : String(claim.property_name),
          pmsType: String(claim.pms_type),
          groupKey: claim.group_key == null ? null : String(claim.group_key),
        },
      ];
    });
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
