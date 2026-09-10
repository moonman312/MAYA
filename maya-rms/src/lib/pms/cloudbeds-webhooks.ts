/**
 * Subscribing to the one Cloudbeds webhook MAYA is required to have.
 *
 * Cloudbeds' rule is a fork: an app that CAN be disconnected from its own UI
 * must call postAppState when that happens; an app that CANNOT "must make sure
 * you're subscribed to our app state webhook so you're notified when they
 * disconnect the apps in Cloudbeds' myfrontdesk". MAYA has no Cloudbeds
 * disconnect button, so the second branch is ours.
 *
 * Each property gets its OWN endpoint URL, with its MAYA hotel id in the path.
 * Cloudbeds send no signature and their payload carries their property id
 * rather than ours, so the alternative would be decrypting every stored secret
 * on every delivery to find out who the event was about. Putting the identity
 * in the subscription makes the lookup free and satisfies their instruction to
 * "only process disconnection on your end for specific webhooks to your own
 * client ID" — the subscription was created with our credentials, so anything
 * arriving there is ours by construction.
 *
 * @see https://developers.cloudbeds.com/docs/connecting-disconnecting-apps
 */

import {
  cloudbedsGetWebhooks,
  cloudbedsPostWebhook,
} from "../../../supabase/functions/_shared/cloudbeds/client";
import type { CloudbedsResolvedCredentials } from "../../../supabase/functions/_shared/cloudbeds/types";

const OBJECT = "integration";
const ACTION = "appstate_changed";

/** Where Cloudbeds should POST app-state changes for one hotel. */
export function appStateWebhookUrl(hotelId: string): string | null {
  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "");
  // No base means no reachable URL to hand over. Localhost is worse than
  // nothing here: Cloudbeds would accept the subscription and then spend five
  // retries a minute apart failing to reach a laptop.
  if (!base || !base.startsWith("https://")) return null;
  return `${base}/api/pms/cloudbeds/webhook/${hotelId}`;
}

export type WebhookEnsureResult =
  | { ok: true; state: "created" | "already_subscribed" }
  | { ok: false; reason: string };

/**
 * Make sure this property is subscribed, exactly once.
 *
 * Idempotent by reading the existing subscriptions first: connecting twice must
 * not leave two subscriptions pointing at the same URL, because Cloudbeds would
 * then deliver every event twice and their own docs say ordering and
 * duplicate-suppression are not guaranteed.
 *
 * NEVER THROWS. A property that connected successfully but could not be
 * subscribed is still a working connection — MAYA falls back to noticing
 * revocation from the 401 on the next sync, which is what it did before this
 * existed. Failing the connect over a monitoring nicety would be the wrong
 * trade.
 */
export async function ensureAppStateWebhook(
  creds: CloudbedsResolvedCredentials,
  hotelId: string,
): Promise<WebhookEnsureResult> {
  const url = appStateWebhookUrl(hotelId);
  if (!url) return { ok: false, reason: "no_public_base_url" };

  try {
    const existing = await cloudbedsGetWebhooks(creds);
    const already = existing.some(
      (w) => w.entity === OBJECT && w.action === ACTION && w.url === url,
    );
    if (already) return { ok: true, state: "already_subscribed" };

    const res = await cloudbedsPostWebhook(creds, OBJECT, ACTION, url);
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true, state: "created" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
