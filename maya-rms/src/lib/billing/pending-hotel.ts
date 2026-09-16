import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { isEntitledStatus } from "@/lib/billing/entitlement";
import { roleRank } from "@/lib/roles";

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
const PENDING_NAME_PREFIX = "Pending setup ";

function pendingName(): string {
  return `${PENDING_NAME_PREFIX}${randomUUID().slice(0, 8)}`;
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
  //
  // A property the owner said "not now" to is skipped: otherwise, once every
  // sibling is deferred, Flow B's step resolver adopts the deferred one as its
  // placeholder and its checkout pays for it through the wrong path. Ahead of
  // the setup_deferred migration the filter cannot be applied, so the read
  // falls back to every parked row, loudly.
  const memberIds = memberships.map((m) => String(m.hotel_id));
  const parked = () =>
    client.from("hotels").select("id").in("id", memberIds).not("setup_pending_at", "is", null);
  let pendingRes = await parked().is("setup_deferred_at", null).order("created_at", { ascending: true });
  if (pendingRes.error && isMissingColumn(pendingRes.error, "setup_deferred_at")) {
    console.error(
      JSON.stringify({
        fn: "findPendingHotelForUser",
        warning: "hotels.setup_deferred_at is missing — run 99_supabase_migration_setup_deferred_v1.sql",
        fallback: "a deferred property can be adopted as Flow B's placeholder until it lands",
      }),
    );
    pendingRes = await parked().order("created_at", { ascending: true });
  }
  const { data: pending, error: pendingErr } = pendingRes;
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

export type PendingHotelSubscription = {
  hotelId: string;
  /** The property's name once the PMS gave it one; null for Flow B's placeholder. */
  name: string | null;
  customerId: string;
  subscriptionId: string;
  status: string;
  /** Already set to cancel at the end of the period: nothing left to cancel in the portal. */
  cancelAtPeriodEnd: boolean;
};

/** Stripe statuses with nothing left to cancel. */
const ENDED_STATUSES = new Set(["canceled", "incomplete_expired"]);

/**
 * The subscription on one of the caller's own pending properties, when there
 * is one left to cancel.
 *
 * A Flow B owner pays (or starts a trial) before connecting a PMS, and the
 * property stays inactive until the connect adopts it. The billing page only
 * sees active properties, so without this an owner who stops at the connect
 * step has no way to cancel online. Only the caller's own active memberships
 * are read, held to the finance bar (General Manager and up) the portal holds
 * everyone else to.
 *
 * Every parked property is considered, not just the one
 * findPendingHotelForUser would adopt: an owner with a Marketplace group, or a
 * leftover placeholder beside a paid one, can have a live subscription on a
 * property that is not first in line. preferHotelId picks the property on
 * screen when it is one of those; it can only choose among the caller's own,
 * so it is safe to take from the browser. Otherwise the oldest wins, with one
 * that still has something to cancel ahead of one already set to cancel.
 *
 * Service-role client. A failed read throws, like findPendingHotelForUser.
 */
export async function findPendingHotelSubscription(
  admin: SupabaseClient,
  userId: string,
  preferHotelId?: string | null,
): Promise<PendingHotelSubscription | null> {
  const { data: memberships, error: membershipErr } = await admin
    .from("hotel_memberships")
    .select("hotel_id, role")
    .eq("user_id", userId)
    .eq("status", "active");
  if (membershipErr) throw new Error(`Could not read memberships: ${membershipErr.message}`);
  const managed = (memberships ?? [])
    .filter((m) => roleRank(String(m.role ?? "")) >= roleRank("general_manager"))
    .map((m) => String(m.hotel_id));
  if (!managed.length) return null;

  // A property the connect already adopted is managed from the billing page.
  const { data: hotels, error: hotelErr } = await admin
    .from("hotels")
    .select("id, name, created_at, is_active, setup_pending_at")
    .in("id", managed)
    .eq("is_active", false)
    .not("setup_pending_at", "is", null);
  if (hotelErr) throw new Error(`Could not read pending properties: ${hotelErr.message}`);
  const parked = (hotels ?? []).filter((h) => h.is_active === false && h.setup_pending_at != null);
  if (!parked.length) return null;

  const { data: subs, error: subErr } = await admin
    .from("hotel_subscriptions")
    .select("hotel_id, stripe_customer_id, stripe_subscription_id, status, cancel_at_period_end")
    .in("hotel_id", parked.map((h) => String(h.id)));
  if (subErr) throw new Error(`Could not read subscriptions: ${subErr.message}`);
  const subByHotel = new Map(
    (subs ?? [])
      .filter((s) => s.stripe_customer_id && s.stripe_subscription_id && !ENDED_STATUSES.has(String(s.status ?? "")))
      .map((s) => [String(s.hotel_id), s]),
  );

  const candidates = parked
    .filter((h) => subByHotel.has(String(h.id)))
    .map((h) => {
      const sub = subByHotel.get(String(h.id))!;
      const name = String(h.name ?? "");
      return {
        hotelId: String(h.id),
        name: name && !name.startsWith(PENDING_NAME_PREFIX) ? name : null,
        customerId: String(sub.stripe_customer_id),
        subscriptionId: String(sub.stripe_subscription_id),
        status: String(sub.status ?? ""),
        cancelAtPeriodEnd: sub.cancel_at_period_end === true,
        createdAt: String(h.created_at ?? ""),
      };
    })
    .sort(
      (a, b) =>
        Number(a.cancelAtPeriodEnd) - Number(b.cancelAtPeriodEnd) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.hotelId.localeCompare(b.hotelId),
    );
  const chosen = candidates.find((c) => c.hotelId === preferHotelId) ?? candidates[0];
  if (!chosen) return null;
  return {
    hotelId: chosen.hotelId,
    name: chosen.name,
    customerId: chosen.customerId,
    subscriptionId: chosen.subscriptionId,
    status: chosen.status,
    cancelAtPeriodEnd: chosen.cancelAtPeriodEnd,
  };
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

export type DeferredMarketplaceHotel = UnpaidMarketplaceHotel & {
  /** When the owner said "not now". */
  deferredAt: string;
};

/**
 * The caller's Marketplace properties that are owned but not yet paid for,
 * oldest first (then by name).
 *
 * A group grant parks one hotel per property and the claim hands the owner all
 * of them at once, but a subscription is per hotel, so they are paid for one
 * at a time. This is the queue: what a redeemed claim points at, still parked,
 * with no live subscription, and not one the owner has said "not now" to —
 * those sit in listDeferredMarketplaceHotels until they are set up from the
 * billing page. The claim row is what separates these from Flow B's
 * placeholder, which has the same shape and must be left to the PMS connect.
 *
 * Service-role client: pms_marketplace_claims is not readable by members.
 */
export async function listUnpaidMarketplaceHotels(
  admin: SupabaseClient,
  userId: string,
): Promise<UnpaidMarketplaceHotel[]> {
  const rows = await listParkedMarketplaceHotels(admin, userId, "unpaid");
  return rows.map(({ hotelId, name, propertyName, pmsType, groupKey }) => ({
    hotelId,
    name,
    propertyName,
    pmsType,
    groupKey,
  }));
}

/**
 * The parked Marketplace properties the owner has said "not now" to. Same
 * queue as listUnpaidMarketplaceHotels, other side of the flag; the billing
 * page lists these with a "Set up" that clears it.
 */
export async function listDeferredMarketplaceHotels(
  admin: SupabaseClient,
  userId: string,
): Promise<DeferredMarketplaceHotel[]> {
  const rows = await listParkedMarketplaceHotels(admin, userId, "deferred");
  return rows.flatMap((r) => (r.deferredAt ? [{ ...r, deferredAt: r.deferredAt }] : []));
}

type ParkedRow = { id: unknown; name?: unknown; created_at?: unknown; setup_deferred_at?: unknown };

/** PostgREST's "column does not exist" — the column's migration has not run here. */
function isMissingColumn(error: { code?: string; message?: string } | null, column: string): boolean {
  if (!error) return false;
  return error.code === "42703" || (error.message ?? "").includes(column);
}

/**
 * The owner's parked Marketplace hotels, split by the "not now" flag. Filtering
 * on setup_deferred_at needs the column to exist, and this code can be running
 * before its migration has: in that case the unpaid list falls back to every
 * parked sibling (what it always was) and the deferred list is empty, with a
 * loud log either way, rather than failing the page that asked.
 */
async function listParkedMarketplaceHotels(
  admin: SupabaseClient,
  userId: string,
  which: "unpaid" | "deferred",
): Promise<(UnpaidMarketplaceHotel & { deferredAt: string | null })[]> {
  const { data: memberships, error: membershipErr } = await admin
    .from("hotel_memberships")
    .select("hotel_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (membershipErr) throw new Error(`Could not read memberships: ${membershipErr.message}`);
  if (!memberships?.length) return [];
  const memberIds = memberships.map((m) => String(m.hotel_id));

  const parked = (columns: string) =>
    admin
      .from("hotels")
      .select(columns)
      .in("id", memberIds)
      .not("setup_pending_at", "is", null)
      .eq("is_active", false);
  const byFlag = parked("id, name, created_at, setup_deferred_at");
  let flagged = await (which === "unpaid"
    ? byFlag.is("setup_deferred_at", null)
    : byFlag.not("setup_deferred_at", "is", null)
  )
    .order("created_at", { ascending: true })
    .order("name", { ascending: true });
  if (flagged.error && isMissingColumn(flagged.error, "setup_deferred_at")) {
    console.error(
      JSON.stringify({
        fn: "listParkedMarketplaceHotels",
        which,
        warning: "hotels.setup_deferred_at is missing — run 99_supabase_migration_setup_deferred_v1.sql",
        fallback: which === "unpaid" ? "offering every parked sibling" : "no deferred properties",
      }),
    );
    if (which === "deferred") return [];
    flagged = await parked("id, name, created_at")
      .order("created_at", { ascending: true })
      .order("name", { ascending: true });
  }
  if (flagged.error) throw new Error(`Could not read pending properties: ${flagged.error.message}`);
  const hotels = (flagged.data ?? []) as unknown as ParkedRow[];
  if (!hotels.length) return [];
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
  const byAge = (a: ParkedRow, b: ParkedRow) =>
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
          deferredAt: h.setup_deferred_at == null ? null : String(h.setup_deferred_at),
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
