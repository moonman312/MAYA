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
 * WHY THE HOTEL ID IS IN THE PATH. Cloudbeds send no signature and their
 * payload carries their own propertyID, not ours — and MAYA stores the
 * Cloudbeds property id inside an encrypted Vault secret, so mapping their id
 * back to a hotel would mean decrypting every connection's secret on every
 * delivery. Instead each property is subscribed with its own endpoint URL, so
 * the subscription itself carries the identity. It also settles their "only
 * process disconnection for webhooks to your own client ID" rule by
 * construction: the subscription was created with our credentials, so anything
 * arriving at this URL is ours.
 *
 * WHY IT ACTS WITHOUT VERIFYING. Marking a connection disconnected is
 * self-healing — the next successful sync sets it back to connected on its own.
 * So the worst a forged request can do, to someone who already knows a hotel's
 * UUID, is show one property as disconnected until the next tick. Calling
 * Cloudbeds back to confirm would cost most of the two-second budget they allow
 * before treating the delivery as failed, to defend against something the next
 * sync corrects anyway.
 */

import { createAdminClient } from "@/utils/supabase/admin";
import { markConnectionDisconnected } from "@/lib/pms/connection-health";
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
  { params }: { params: Promise<{ hotelId: string }> },
) {
  // Every path below answers 2xx. Cloudbeds retry five times, a minute apart,
  // on anything else — and a retry cannot fix a payload we do not understand or
  // a hotel that no longer exists. Reserve non-2xx for nothing at all.
  const { hotelId } = await params;

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
