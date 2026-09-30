/**
 * "Send a test alert" on the Command Center, answered from inside a scheduled
 * sync function.
 *
 * Real alerts are raised inside the edge functions (a revoked connection, a
 * pricing run that keeps failing, prices not reaching the PMS), which read
 * MAYA_ALERT_WEBHOOK from the Supabase function secrets. The app has its own
 * copy of the setting, so a test sent from the app proved only that the
 * app's copy worked: the address could be set in Vercel and missing in the
 * function secrets, and every real alert would then be skipped in silence.
 * So the button asks a scheduled sync to send the test, over the same
 * endpoint the cron calls, protected by the same secret. What comes back is
 * what that function found about its own settings.
 *
 * The request body is `{ action: "test_alert", sent_by?: string }`. The
 * function refuses it unless its cron secret is configured: an endpoint that
 * fails open on a missing secret must not also send messages on request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { type AlertChannelTest, sendAlertChannelTest } from "./alerting.ts";

export const TEST_ALERT_ACTION = "test_alert";

/** The body a scheduled sync function takes: a single-hotel dispatch, or the test alert. */
export type ScheduledSyncBody = {
  hotel_id?: string;
  action?: string;
  sent_by?: string;
};

/** The body as posted, or an empty one for no body or one that is not JSON. */
export function parseScheduledSyncBody(text: string): ScheduledSyncBody {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const b = parsed as Record<string, unknown>;
    return {
      ...(b.hotel_id != null && b.hotel_id !== "" ? { hotel_id: String(b.hotel_id) } : {}),
      ...(typeof b.action === "string" ? { action: b.action } : {}),
      ...(typeof b.sent_by === "string" && b.sent_by ? { sent_by: b.sent_by.slice(0, 200) } : {}),
    };
  } catch {
    return {};
  }
}

export type TestAlertAnswer =
  | { ok: true; test: AlertChannelTest }
  | { ok: false; error: string };

/**
 * Answer a test-alert request, or null when the body is not one. The cron
 * secret check has already run; this only insists the secret exists at all.
 */
export async function handleTestAlertRequest(
  supabase: SupabaseClient,
  body: ScheduledSyncBody,
  opts: { fn: string; secretEnv: string; secretConfigured: boolean },
): Promise<Response | null> {
  if (body.action !== TEST_ALERT_ACTION) return null;
  const json = (answer: TestAlertAnswer, status: number) =>
    new Response(JSON.stringify(answer), { status, headers: { "Content-Type": "application/json" } });
  if (!opts.secretConfigured) {
    return json(
      {
        ok: false,
        error: `${opts.secretEnv} is not set for ${opts.fn}, so it takes no test alert request. Set it in the Supabase function secrets, and the same value in the app.`,
      },
      403,
    );
  }
  const test = await sendAlertChannelTest(supabase, { fn: opts.fn, sentBy: body.sent_by ?? null });
  console.log(JSON.stringify({ fn: opts.fn, step: "test_alert", ...test }));
  return json({ ok: true, test }, 200);
}
