/**
 * The check at connect for the currencies MAYA takes a property on in
 * (supabase/functions/_shared/pms/currencies.ts, Jake 2026-09-30, audits A20
 * and A58). Both ways a property connects ask it right after the PMS says
 * who the property is and before anything is stored: the onboarding OAuth
 * callback (connect.ts) and a Cloudbeds Marketplace "Connect App"
 * (lib/pms/marketplace-connect.ts). A property it stops has no hotel row
 * made or renamed for it, no credential, no connection and no import.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { currencyCode, currencySupported } from "../../../supabase/functions/_shared/pms/currencies";

/** The sentence the person connecting reads. `currency` is the code the PMS reported. */
export function currencyRefusal(currency: string): string {
  return (
    `Your property's system uses ${currency}. MAYA doesn't price in ${currency} yet, ` +
    "so nothing was set up or imported. Email us and we'll tell you when it does."
  );
}

/** The refusal for a property whose system reports `raw`, or null when it may connect. */
export function currencyRefusalFor(raw: unknown): string | null {
  if (currencySupported(raw)) return null;
  return currencyRefusal(currencyCode(raw) ?? String(raw));
}

/**
 * Record a refused connect as pms.currency_refused (docs/analytics.md), so
 * the demand for a currency can be counted. `paid` says the person had
 * already paid at checkout (the maya-rms.com path): then the database also
 * posts a line to #maya-signups, so someone refunds or cancels the
 * subscription in Stripe (99_supabase_migration_signups_feed_v3.sql). Never
 * throws: analytics must not change what the person at the browser is told.
 */
export async function recordCurrencyRefused(
  admin: SupabaseClient,
  input: {
    currency: string;
    pmsType: string;
    via: "onboarding_oauth" | "marketplace_flow_a";
    /** They had paid at checkout before connecting. */
    paid?: boolean;
    hotelId?: string | null;
    userId?: string | null;
    propertyId?: string | null;
    propertyName?: string | null;
  },
): Promise<void> {
  try {
    const { error } = await admin.rpc("product_event_emit", {
      p_event: "pms.currency_refused",
      p_hotel_id: input.hotelId ?? null,
      p_user_id: input.userId ?? null,
      p_properties: { currency: input.currency, via: input.via, ...(input.paid ? { paid: true } : {}) },
      p_source: "app",
      p_pms_type: input.pmsType,
      p_pms_property_id: input.propertyId ?? null,
      p_property_name: input.propertyName ?? null,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "recordCurrencyRefused",
        currency: input.currency,
        via: input.via,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
