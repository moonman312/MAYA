/**
 * Cloudbeds integration webhook — how MAYA finds out it has been disconnected.
 *
 * Cloudbeds require that an app which cannot be disconnected from its own UI
 * subscribes to `integration/appstate_changed`, and that it "immediately
 * terminate the API sessions" once a property uninstalls the app in
 * myfrontdesk. MAYA offers no Cloudbeds disconnect button, so this is the half
 * of that requirement that applies to us. Without it the first sign of a
 * revoked grant is a 401 on the next scheduled sync, up to five minutes of
 * calling an endpoint that has already told us to go away.
 *
 * WHY THE IDENTITY IS IN THE PATH. Cloudbeds send no signature and their
 * payload carries their own propertyID, not ours — and MAYA stores the
 * Cloudbeds property id inside an encrypted Vault secret, so mapping their id
 * back to a hotel would mean decrypting every connection's secret on every
 * delivery. Each property is subscribed with its own endpoint URL instead, so
 * the subscription itself carries the identity.
 *
 * WHY THE PATH IS SIGNED. Disconnecting is NOT reversible on its own: the
 * scheduler claims work with `where status <> 'disconnected'`, so a hotel marked
 * disconnected is dropped from every future batch and there is no later sync to
 * put it back. An unauthenticated version of this route would therefore be a
 * permanent kill switch for any property whose id you know — and a hotel id is
 * not a secret, since every member of that hotel holds one and it sits in a
 * plaintext cookie. The token is an HMAC over the hotel id, keyed with the same
 * secret that signs OAuth state; MAYA chooses the URL and Cloudbeds echo it back
 * verbatim, so the path is the credential. That also settles their "only process
 * disconnection for webhooks to your own client ID" rule by construction.
 */

import { createAdminClient } from "@/utils/supabase/admin";
import { markConnectionDisconnected } from "@/lib/pms/connection-health";
import { verifyWebhookToken } from "@/lib/pms/cloudbeds-webhooks";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cloudbeds' app states. Only `disabled` means the grant is gone. */
const DEAD_STATES = new Set(["disabled"]);

type AppStatePayload = {
  event?: unknown;
  propertyID?: unknown;
  propertyID_str?: unknown;
  /** The new state. Cloudbeds have used more than one field name for this. */
  state?: unknown;
  app_state?: unknown;
  appState?: unknown;
  status?: unknown;
};

/** Read the new state out of whichever field this delivery happens to use. */
function readState(body: AppStatePayload): string | null {
  for (const v of [body.state, body.app_state, body.appState, body.status]) {
    if (typeof v === "string" && v) return v.toLowerCase();
  }
  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hotelId: string; token: string }> },
) {
  // Every path below answers 2xx. Cloudbeds retry five times, a minute apart,
  // on anything else — and a retry cannot fix a payload we do not understand, a
  // hotel that no longer exists, or a bad token. Reserve non-2xx for nothing.
  const { hotelId, token } = await params;

  // Before anything else, and before any database work: an unsigned request
  // gets the same empty 200 as a signed one, so this is not an oracle for
  // which hotel ids exist.
  if (!verifyWebhookToken(hotelId, token)) {
    console.error(JSON.stringify({ fn: "cloudbedsWebhook", hotelId, error: "bad_token" }));
    return NextResponse.json({ received: true }, { status: 200 });
  }

  let body: AppStatePayload;
  try {
    // Their docs show application/x-www-form-urlencoded on the subscribe call
    // and JSON payloads on delivery, so accept either rather than assume.
    const raw = await request.text();
    body = raw.trim().startsWith("{")
      ? (JSON.parse(raw) as AppStatePayload)
      : (Object.fromEntries(new URLSearchParams(raw)) as AppStatePayload);
  } catch {
    console.error(JSON.stringify({ fn: "cloudbedsWebhook", hotelId, error: "unparseable_body" }));
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const event = typeof body.event === "string" ? body.event : "";
  const state = readState(body);

  console.log(
    JSON.stringify({
      fn: "cloudbedsWebhook",
      hotelId,
      event,
      state,
      propertyId: String(body.propertyID_str ?? body.propertyID ?? ""),
    }),
  );

  if (event !== "integration/appstate_changed") {
    // Subscribed to one event, but a shared endpoint or a future subscription
    // could deliver others. Acknowledge and ignore.
    return NextResponse.json({ received: true }, { status: 200 });
  }

  if (!state || !DEAD_STATES.has(state)) {
    // enabled / pending / installing. Reconnection is handled by the ordinary
    // OAuth callback, which writes a fresh secret and flips the status itself.
    return NextResponse.json({ received: true }, { status: 200 });
  }

  try {
    const admin = createAdminClient();
    await markConnectionDisconnected(
      admin,
      hotelId,
      "cloudbeds",
      "Property uninstalled the app in Cloudbeds (integration/appstate_changed → disabled)",
    );
  } catch (e) {
    // markConnectionDisconnected already swallows its own failures; this catches
    // the client construction. Still a 200 — a retry would not help.
    console.error(
      JSON.stringify({
        fn: "cloudbedsWebhook",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
