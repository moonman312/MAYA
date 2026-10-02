import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendAccountReadyOnce } from "./account-ready";
import { isEntitledStatus } from "./entitlement";
import type { SubscriptionProjection } from "./sync";
import { activateMarketplaceHotelIfPending } from "@/lib/pms/marketplace-activate";

/**
 * What follows a subscription being recorded, whoever recorded it: the
 * webhook, or the nightly Stripe check catching up on a message that never
 * arrived. A paid Marketplace property goes live and adopts the import its
 * claim started, and the "Your account is ready" email goes out (claimed in
 * the database, so one sends however many paths get here).
 *
 * Never fails the caller: the subscription was recorded correctly, Stripe
 * retrying would not help, and the next page load re-attempts activation on
 * its own.
 */
export async function afterSubscriptionSaved(
  admin: SupabaseClient,
  stripe: Stripe,
  sub: Stripe.Subscription,
  row: SubscriptionProjection,
): Promise<void> {
  if (isEntitledStatus(row.status)) {
    try {
      await activateMarketplaceHotelIfPending(admin, row.hotel_id, {
        requestedBy: sub.metadata?.user_id || null,
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          fn: "afterSubscriptionSaved",
          step: "activate_marketplace",
          hotel: row.hotel_id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
  await sendAccountReadyOnce(admin, stripe, sub, row);
}
