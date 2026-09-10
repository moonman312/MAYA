import "server-only";
import { ensureAppStateWebhook } from "@/lib/pms/cloudbeds-webhooks";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  cloudbedsDiscoverPropertyId,
  cloudbedsGetHotelDetails,
  cloudbedsListProperties,
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
  | { kind: "reconnected"; hotelId: string; propertyName: string | null; groupProperties?: number }
  | { kind: "claim"; token: string; propertyName: string | null; groupProperties?: number; parked?: number }
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

  // A grant from a GROUP user covers EVERY property in the group, not one —
  // Cloudbeds: "the access token or API keys will provide data for the entire
  // group". Taking the first entry, which is what a single-property discover
  // does, silently connects one hotel and drops the rest. So we connect them
  // all, and hand back one ticket that claims the whole bundle.
  //
  // Each property keeps its own copy of the credentials with its own
  // propertyId. That is only safe because Cloudbeds does not rotate refresh
  // tokens (verified 2026-09-09: the same token comes back), so siblings
  // refresh independently without invalidating one another.
  let properties = await cloudbedsListProperties(bare);
  if (properties.length === 0) {
    // Fall back to the single-property discovery path: an account whose
    // getHotels we cannot read still has one property we can identify.
    try {
      const only = await cloudbedsDiscoverPropertyId(bare);
      if (only) properties = [{ propertyId: only, name: null }];
    } catch (e) {
      return {
        kind: "error",
        message: `Could not identify the property for this connection: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  if (properties.length === 0) {
    return { kind: "error", message: "Cloudbeds did not report a property for this authorization." };
  }

  const isGroup = properties.length > 1;
  const admin = createAdminClient();
  // Stable across reconnects, so a group that connects twice reuses its bundle.
  const groupKey = isGroup
    ? `${pmsType}:group:${[...properties.map((p) => p.propertyId)].sort().join(",")}`
    : null;

  const parked: { token: string; hotelId: string; name: string | null }[] = [];
  const reconnected: { hotelId: string; name: string | null }[] = [];
  const failures: string[] = [];

  for (const property of properties) {
    const key = enterpriseKey(pmsType, property.propertyId);
    const creds = { ...bare, propertyId: property.propertyId };

    // Name/timezone/currency per property — a group's hotels are not clones.
    let propertyName = property.name;
    let timezone = "UTC";
    let currency = "USD";
    try {
      const details = await cloudbedsGetHotelDetails(creds);
      propertyName = details.name ?? propertyName;
      timezone = details.timezone ?? "UTC";
      currency = details.currency ?? "USD";
    } catch {
      // Naming is a nicety; an unnamed property is still connectable.
    }

    const storeSecret = async (hotelId: string) =>
      await admin.rpc("pms_secret_set", {
        p_hotel_id: hotelId,
        p_pms_type: pmsType,
        p_secret: { ...tokens, propertyId: property.propertyId },
      });

    // Ask Cloudbeds to tell us if this property ever uninstalls the app. Never
    // blocks the connect: a property that is connected but unsubscribed still
    // works, and MAYA falls back to noticing revocation from the next 401.
    const subscribe = async (hotelId: string) => {
      const res = await ensureAppStateWebhook(
        { accessToken: tokens.accessToken, tokenType: tokens.tokenType, baseUrl, propertyId: property.propertyId },
        hotelId,
      );
      if (!res.ok) {
        console.error(
          JSON.stringify({ fn: "handleMarketplaceConnect", step: "webhook", hotelId, reason: res.reason }),
        );
      }
    };

    const { data: existing } = await admin
      .from("hotels")
      .select("id, name")
      .eq("external_enterprise_id", key)
      .maybeSingle();

    const now = new Date().toISOString();

    if (existing?.id) {
      const { error } = await storeSecret(existing.id);
      if (error) {
        failures.push(`${property.propertyId}: ${error.message}`);
        continue;
      }
      await admin.from("pms_connections").upsert(
        { hotel_id: existing.id, pms_type: pmsType, status: "connected", last_tested_at: now, updated_at: now },
        { onConflict: "hotel_id,pms_type" },
      );
      await subscribe(existing.id);
      await admin.rpc("platform_log_event", {
        p_event_type: "pms.connected",
        p_entity_type: "pms_connection",
        p_entity_id: existing.id,
        p_hotel_id: existing.id,
        p_detail: { pms_type: pmsType, via: "marketplace_flow_a", reconnect: true, ...(isGroup ? { group_properties: properties.length } : {}) },
      });
      reconnected.push({ hotelId: existing.id, name: propertyName ?? existing.name });
      continue;
    }

    // hotels.name is globally unique, so a collision must never block a
    // connection — fall through to progressively more specific names.
    const placeholder = propertyName?.trim() || `Cloudbeds property ${property.propertyId}`;
    let hotelId: string | null = null;
    for (const candidate of [
      placeholder,
      `${placeholder} (${property.propertyId})`,
      `${placeholder} ${crypto.randomUUID().slice(0, 6)}`,
    ]) {
      const { data, error } = await admin
        .from("hotels")
        .insert({
          name: candidate,
          timezone,
          currency,
          is_active: false,
          setup_pending_at: now,
          external_enterprise_id: key,
        })
        .select("id")
        .single();
      if (!error && data) {
        hotelId = data.id;
        break;
      }
      if (error && !/duplicate key|unique/i.test(error.message)) {
        failures.push(`${property.propertyId}: ${error.message}`);
        break;
      }
    }
    if (!hotelId) {
      failures.push(`${property.propertyId}: could not create the property`);
      continue;
    }

    const { error: secretErr } = await storeSecret(hotelId);
    if (secretErr) {
      failures.push(`${property.propertyId}: ${secretErr.message}`);
      continue;
    }

    await admin.from("pms_connections").upsert(
      { hotel_id: hotelId, pms_type: pmsType, status: "pending", last_tested_at: now, updated_at: now },
      { onConflict: "hotel_id,pms_type" },
    );

    await subscribe(hotelId);

    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
    const claimRow = {
      token,
      hotel_id: hotelId,
      pms_type: pmsType,
      external_property_id: key,
      property_name: propertyName,
      expires_at: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
    };
    let { error: claimErr } = await admin
      .from("pms_marketplace_claims")
      .insert({ ...claimRow, group_key: groupKey });
    if (claimErr && /group_key/i.test(claimErr.message)) {
      // group_key arrives in its own migration. If this deploys first, a single
      // property must still connect rather than Flow A failing outright — the
      // only thing lost is bundling, and a group would then be claimed one
      // property at a time instead of not at all.
      console.warn(
        JSON.stringify({
          fn: "handleMarketplaceConnect",
          event: "group_key_column_missing",
          detail: "claims created without bundling; run the marketplace groups migration",
        }),
      );
      ({ error: claimErr } = await admin.from("pms_marketplace_claims").insert(claimRow));
    }
    if (claimErr) {
      failures.push(`${property.propertyId}: ${claimErr.message}`);
      continue;
    }

    await admin.rpc("platform_log_event", {
      p_event_type: "pms.marketplace_pending",
      p_entity_type: "pms_connection",
      p_entity_id: hotelId,
      p_hotel_id: hotelId,
      p_detail: {
        pms_type: pmsType,
        via: "marketplace_flow_a",
        property_id: property.propertyId,
        ...(isGroup ? { group_properties: properties.length, group_key: groupKey } : {}),
      },
    });
    parked.push({ token, hotelId, name: propertyName });
  }

  if (failures.length > 0) {
    console.error(
      JSON.stringify({ fn: "handleMarketplaceConnect", event: "partial_group_connect", failures }),
    );
  }

  // Nothing landed at all — say so rather than sending them to a login page
  // that will not have a property waiting.
  if (parked.length === 0 && reconnected.length === 0) {
    return { kind: "error", message: failures[0] ?? "Could not connect any property." };
  }

  // Anything parked means someone has to claim it, even if other properties in
  // the same group reconnected — a half-claimed group is still unclaimed.
  if (parked.length > 0) {
    return {
      kind: "claim",
      token: parked[0].token,
      propertyName: parked[0].name,
      ...(isGroup ? { groupProperties: properties.length, parked: parked.length } : {}),
    };
  }

  return {
    kind: "reconnected",
    hotelId: reconnected[0].hotelId,
    propertyName: reconnected[0].name,
    ...(isGroup ? { groupProperties: properties.length } : {}),
  };
}
