import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  cloudbedsDiscoverPropertyId,
  cloudbedsGetHotelDetails,
} from "../../../supabase/functions/_shared/cloudbeds/client";
import { defaultCloudbedsBaseUrl } from "../../../supabase/functions/_shared/cloudbeds/constants";
import type { PmsType } from "@/lib/pms/registry";

/**
 * Flow A — a connection that started in the Cloudbeds Marketplace.
 *
 * Cloudbeds has required this flow for all new apps since 2020-11-01. The user
 * clicks "Connect App" over on Cloudbeds, approves the scopes, and lands on our
 * callback. Two things are unlike the flow MAYA already had:
 *
 *   1. There is no `state`, because MAYA did not start the exchange. The
 *      callback cannot verify a signature it never issued, so identity has to
 *      come from the grant itself — we spend the token, ask Cloudbeds which
 *      property it belongs to, and trust that answer rather than the URL.
 *   2. There may be no MAYA account yet, and Flow A is explicit that the app
 *      needs no account-creation UI. So a valid grant for an unclaimed property
 *      has to be parked safely rather than refused.
 *
 * Parking it means creating the hotel row immediately — credentials may only
 * live in the Vault, and pms_secret_set is keyed by hotel_id, so the hotel has
 * to exist before the tokens can be stored anywhere. The row is inert until
 * claimed: is_active false, setup_pending_at set, and no membership, so it
 * prices nothing and nobody can see it. The claim ticket is what later attaches
 * an owner.
 */

export type MarketplaceTokens = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: unknown;
  expiresAt: string;
};

export type MarketplaceOutcome =
  | { kind: "reconnected"; hotelId: string; propertyName: string | null }
  | { kind: "claim"; token: string; propertyName: string | null }
  | { kind: "error"; message: string };

/** Namespaced so two PMSes can never collide on the same bare property number. */
export function enterpriseKey(pmsType: PmsType, externalPropertyId: string): string {
  return `${pmsType}:${externalPropertyId}`;
}

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export async function handleMarketplaceConnect(
  pmsType: PmsType,
  tokens: MarketplaceTokens,
): Promise<MarketplaceOutcome> {
  if (pmsType !== "cloudbeds") {
    return { kind: "error", message: `${pmsType} does not support marketplace-initiated connections.` };
  }

  const baseUrl = defaultCloudbedsBaseUrl();
  const bare = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    baseUrl,
  };

  // Identity comes from the grant, not the URL: ask Cloudbeds who this is for.
  let propertyId: string | null;
  try {
    propertyId = await cloudbedsDiscoverPropertyId(bare);
  } catch (e) {
    return {
      kind: "error",
      message: `Could not identify the property for this connection: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!propertyId) {
    return { kind: "error", message: "Cloudbeds did not report a property for this authorization." };
  }

  const creds = { ...bare, propertyId };
  let propertyName: string | null = null;
  let timezone = "UTC";
  let currency = "USD";
  try {
    const details = await cloudbedsGetHotelDetails(creds);
    propertyName = details.name ?? null;
    timezone = details.timezone ?? "UTC";
    currency = details.currency ?? "USD";
  } catch {
    // Naming is a nicety; an unnamed property is still connectable.
  }

  const admin = createAdminClient();
  const key = enterpriseKey(pmsType, propertyId);

  const storeSecret = async (hotelId: string) =>
    await admin.rpc("pms_secret_set", {
      p_hotel_id: hotelId,
      p_pms_type: pmsType,
      p_secret: { ...tokens, propertyId },
    });

  // ── Already ours? Then this is a RE-connect, and it must land on the same
  //    hotel rather than minting a second one for the same property.
  const { data: existing } = await admin
    .from("hotels")
    .select("id, name")
    .eq("external_enterprise_id", key)
    .maybeSingle();

  if (existing?.id) {
    const { error: secretErr } = await storeSecret(existing.id);
    if (secretErr) return { kind: "error", message: `Could not store credentials: ${secretErr.message}` };

    const now = new Date().toISOString();
    await admin.from("pms_connections").upsert(
      { hotel_id: existing.id, pms_type: pmsType, status: "connected", last_tested_at: now, updated_at: now },
      { onConflict: "hotel_id,pms_type" },
    );
    await admin.rpc("platform_log_event", {
      p_event_type: "pms.connected",
      p_entity_type: "pms_connection",
      p_entity_id: existing.id,
      p_hotel_id: existing.id,
      p_detail: { pms_type: pmsType, via: "marketplace_flow_a", reconnect: true },
    });

    // A property that reconnects after being revoked has a membership already,
    // so there is nothing to claim — send them to sign in, exactly as Flow A
    // describes ("Connect App" becomes "Login").
    return { kind: "reconnected", hotelId: existing.id, propertyName: propertyName ?? existing.name };
  }

  // ── Unclaimed property: park the grant on an inert hotel and mint a ticket.
  const placeholder = propertyName?.trim()
    ? `${propertyName.trim()}`
    : `Cloudbeds property ${propertyId}`;

  // hotels.name is globally unique, so a collision must not block a connection.
  let hotelId: string | null = null;
  for (const candidate of [placeholder, `${placeholder} (${propertyId})`, `${placeholder} ${crypto.randomUUID().slice(0, 6)}`]) {
    const { data, error } = await admin
      .from("hotels")
      .insert({
        name: candidate,
        timezone,
        currency,
        is_active: false,
        setup_pending_at: new Date().toISOString(),
        external_enterprise_id: key,
      })
      .select("id")
      .single();
    if (!error && data) {
      hotelId = data.id;
      break;
    }
    if (error && !/duplicate key|unique/i.test(error.message)) {
      return { kind: "error", message: `Could not create the property: ${error.message}` };
    }
  }
  if (!hotelId) return { kind: "error", message: "Could not create the property (name conflict)." };

  const { error: secretErr } = await storeSecret(hotelId);
  if (secretErr) return { kind: "error", message: `Could not store credentials: ${secretErr.message}` };

  const now = new Date().toISOString();
  await admin.from("pms_connections").upsert(
    { hotel_id: hotelId, pms_type: pmsType, status: "pending", last_tested_at: now, updated_at: now },
    { onConflict: "hotel_id,pms_type" },
  );

  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const { error: claimErr } = await admin.from("pms_marketplace_claims").insert({
    token,
    hotel_id: hotelId,
    pms_type: pmsType,
    external_property_id: key,
    property_name: propertyName,
    expires_at: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
  });
  if (claimErr) return { kind: "error", message: `Could not prepare the connection: ${claimErr.message}` };

  await admin.rpc("platform_log_event", {
    p_event_type: "pms.marketplace_pending",
    p_entity_type: "pms_connection",
    p_entity_id: hotelId,
    p_hotel_id: hotelId,
    p_detail: { pms_type: pmsType, via: "marketplace_flow_a", property_id: propertyId },
  });

  return { kind: "claim", token, propertyName };
}
