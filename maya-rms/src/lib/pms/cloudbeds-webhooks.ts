import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Subscribing to the one Cloudbeds webhook MAYA is required to have.
 *
 * Cloudbeds' rule is a fork: an app that CAN be disconnected from its own UI
 * must call postAppState when that happens; an app that CANNOT "must make sure
 * you're subscribed to our app state webhook so you're notified when they
 * disconnect the apps in Cloudbeds' myfrontdesk". MAYA has no Cloudbeds
 * disconnect button, so the second branch is ours.
 *
 * WHY THE URL IS SIGNED. Cloudbeds send no signature of their own, so the
 * receiving URL is the only thing that can prove a delivery is genuine. MAYA
 * chooses that URL and Cloudbeds echo it back verbatim on every delivery, so an
 * HMAC over the hotel id — keyed with the same secret that signs OAuth state —
 * turns the path itself into the credential. No storage, no extra config.
 *
 * This is not belt-and-braces; without it the endpoint is a kill switch.
 * Disconnecting a property REMOVES IT FROM THE SCHEDULER: claim_pms_sync_batch
 * selects `where status <> 'disconnected'`, so nothing picks the hotel up again
 * and there is no later sync to undo it. An unauthenticated POST would stop a
 * live property's pricing indefinitely, and the hotel id alone is not a secret
 * — every member of a hotel has it, and it sits in a plaintext cookie.
 *
 * @see https://developers.cloudbeds.com/docs/connecting-disconnecting-apps
 */

import {
  cloudbedsGetWebhooks,
  cloudbedsPostWebhook,
} from "../../../supabase/functions/_shared/cloudbeds/client";
import type { CloudbedsResolvedCredentials } from "../../../supabase/functions/_shared/cloudbeds/types";
import { getStateSecret } from "./oauth-state";

const OBJECT = "integration";
const ACTION = "appstate_changed";

/** Domain-separated so this signature can never be replayed as an OAuth state. */
function signature(hotelId: string): string {
  return createHmac("sha256", getStateSecret())
    .update(`cloudbeds-webhook:${hotelId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * True when `token` is the signature MAYA would have issued for this hotel.
 *
 * Compared in constant time. A wrong-length token is rejected before the
 * comparison, because timingSafeEqual throws on mismatched lengths.
 */
export function verifyWebhookToken(hotelId: string, token: string | undefined): boolean {
  if (!token) return false;
  let expected: string;
  try {
    expected = signature(hotelId);
  } catch {
    // No signing secret configured — refuse rather than wave everything through.
    return false;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Where Cloudbeds should POST app-state changes for one hotel. */
export function appStateWebhookUrl(hotelId: string): string | null {
  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "");
  // No base means no reachable URL to hand over. Localhost is worse than
  // nothing here: Cloudbeds would accept the subscription and then spend five
  // retries a minute apart failing to reach a laptop.
  if (!base || !base.startsWith("https://")) return null;
  try {
    return `${base}/api/pms/cloudbeds/webhook/${hotelId}/${signature(hotelId)}`;
  } catch {
    // Missing PMS_OAUTH_STATE_SECRET. Better to register no webhook at all than
    // one nobody can authenticate.
    return null;
  }
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
