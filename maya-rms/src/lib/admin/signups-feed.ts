import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingFunctionError } from "@/lib/engine/snapshots";

// The #maya-signups Slack feed. The database posts it: a trigger on
// product_events sends one line per real signup milestone through pg_net to
// the incoming webhook stored in Vault as maya_signups_webhook
// (99_supabase_migration_signups_feed_v1.sql). The app never holds the
// address. All it does is ask signup_feed_test() for one test line, under the
// admin's own session, and say what came back.

export const SIGNUPS_FEED_MIGRATION = "99_supabase_migration_signups_feed_v1.sql";

export type SignupsFeedTestResult = { sent: true } | { sent: false; error: string };

/** What signup_feed_test() answered, in words for the person at the button. */
export function describeSignupsFeedTest(answer: { sent?: unknown; state?: unknown; error?: unknown } | null): SignupsFeedTestResult {
  if (answer?.sent === true) return { sent: true };
  switch (answer?.state) {
    case "missing":
      return {
        sent: false,
        error: "There's no maya_signups_webhook in Vault yet, so the feed posts nothing. Add it in Supabase (Vault), then try again.",
      };
    case "not_https":
      return { sent: false, error: "maya_signups_webhook in Vault isn't an https:// address, so the feed posts nothing. Fix it in Supabase (Vault)." };
    case "post_failed":
      return {
        sent: false,
        error: `The database couldn't queue the message${typeof answer?.error === "string" ? ` (${answer.error})` : ""}. Check that pg_net is enabled.`,
      };
    default:
      return { sent: false, error: "The database didn't say whether the test went out. Try again in a moment." };
  }
}

/** Asks the database for one test line to #maya-signups. Never throws. */
export async function sendSignupsFeedTest(ssr: SupabaseClient): Promise<SignupsFeedTestResult> {
  const { data, error } = await ssr.rpc("signup_feed_test");
  if (error) {
    if (isMissingFunctionError(error)) return { sent: false, error: `Run ${SIGNUPS_FEED_MIGRATION} first: the feed lives in the database.` };
    return { sent: false, error: `The database refused the test: ${error.message}` };
  }
  return describeSignupsFeedTest((data ?? null) as { sent?: unknown; state?: unknown; error?: unknown } | null);
}
