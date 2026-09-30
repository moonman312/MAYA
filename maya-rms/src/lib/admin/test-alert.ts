import "server-only";
import type { AlertChannelTest } from "../../../supabase/functions/_shared/pms/alerting";
import { TEST_ALERT_ACTION } from "../../../supabase/functions/_shared/pms/alert-test-request";
import { SYNC_NUDGE } from "@/lib/pms/sync-nudge";

// "Send a test alert" on the Command Center: one message to the alert channel
// (MAYA_ALERT_WEBHOOK, our Slack), so someone can see alerts arrive without
// waiting for something to break.
//
// Real alerts are raised inside the scheduled sync functions, which read the
// address from the Supabase function secrets. The app has a copy of its own,
// and a test sent from here proved only that the app's copy worked: the
// address could be set in Vercel and missing in the function secrets, and
// every real alert then skipped without a word. So the test is sent by a
// scheduled sync function, asked over the endpoint the cron calls with the
// same secret (alert-test-request.ts), and the answer is what that function
// found about its own settings. The webhook address never reaches the app.

/** How long the button waits on the function before saying so. */
export const TEST_ALERT_TIMEOUT_MS = 20_000;

/** The scheduled sync function the test goes through, and the secret the app holds for it. */
export type TestAlertRoute = { fn: string; header: string; secret: string; url: string };

/**
 * Which function the app can ask. The Supabase function secrets are shared
 * by every function in the project, so one answers for them all: the first
 * of Cloudbeds, Think and Mews whose cron secret the app holds.
 */
export function testAlertRoute(env: NodeJS.ProcessEnv = process.env): TestAlertRoute | null {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  if (!supabaseUrl) return null;
  for (const pms of ["cloudbeds", "think", "mews"]) {
    const nudge = SYNC_NUDGE[pms];
    const secret = env[nudge.env];
    if (secret) return { fn: nudge.fn, header: nudge.header, secret, url: `${supabaseUrl}/functions/v1/${nudge.fn}` };
  }
  return null;
}

/** Why no test alert can be asked for from this deployment, in plain words, or null when one can. */
export function testAlertProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (testAlertRoute(env)) return null;
  return (
    "The app can't ask a scheduled sync to send the test: set CLOUDBEDS_CRON_SECRET (or THINK_CRON_SECRET, MEWS_CRON_SECRET) " +
    "and NEXT_PUBLIC_SUPABASE_URL in the app's environment variables in Vercel, with the same secret the function has, then redeploy."
  );
}

export type TestAlertResult =
  | { sent: true; fn: string; minSeverity: "warn" | "critical" }
  | { sent: false; fn: string | null; error: string };

/** What the function's answer means for the person at the button. */
export function describeTestAlertAnswer(fn: string, test: AlertChannelTest): TestAlertResult {
  if (test.sent) return { sent: true, fn, minSeverity: test.minSeverity };
  if (test.state === "missing") {
    return {
      sent: false,
      fn,
      error: `MAYA_ALERT_WEBHOOK isn't set in the Supabase function secrets, so ${fn} has nowhere to send alerts. Real alerts are being skipped. Add it there (Dashboard, Edge Functions, Secrets).`,
    };
  }
  if (test.state === "not_https") {
    return {
      sent: false,
      fn,
      error: `MAYA_ALERT_WEBHOOK in the Supabase function secrets isn't an https:// address, so ${fn} won't send to it. Real alerts are being skipped. Fix it there.`,
    };
  }
  if (test.reason === "timeout") {
    return { sent: false, fn, error: `The alert channel didn't answer ${fn} in time, so the test may not have arrived.` };
  }
  if (test.reason?.startsWith("webhook_")) {
    return {
      sent: false,
      fn,
      error: `The alert channel refused the message from ${fn} (HTTP ${test.reason.slice("webhook_".length)}). Check that MAYA_ALERT_WEBHOOK in the function secrets is still a live webhook.`,
    };
  }
  return { sent: false, fn, error: `${fn} couldn't reach the alert channel. Try again in a moment.` };
}

/**
 * Ask the scheduled sync function to send the one test message, and say what
 * it found. Never throws.
 */
export async function sendTestAlert(
  sentBy: string | null,
  deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<TestAlertResult> {
  const route = testAlertRoute(deps.env ?? process.env);
  if (!route) return { sent: false, fn: null, error: testAlertProblem(deps.env ?? process.env) ?? "The alert test isn't set up." };
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(route.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [route.header]: route.secret },
      body: JSON.stringify({ action: TEST_ALERT_ACTION, ...(sentBy ? { sent_by: sentBy } : {}) }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TEST_ALERT_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      sent: false,
      fn: route.fn,
      error: timedOut
        ? `${route.fn} didn't answer within ${Math.round((deps.timeoutMs ?? TEST_ALERT_TIMEOUT_MS) / 1000)} seconds. Check that it is deployed, then try again.`
        : `Couldn't reach ${route.fn}. Check that it is deployed, then try again.`,
    };
  }
  let body: { ok?: boolean; test?: AlertChannelTest; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (res.status === 401) {
    return {
      sent: false,
      fn: route.fn,
      error: `${route.fn} refused the app's secret. The app's ${cronSecretEnvOf(route.fn)} must be the same value as the function's.`,
    };
  }
  if (!res.ok || !body.ok || !body.test) {
    return {
      sent: false,
      fn: route.fn,
      error: body.error ?? `${route.fn} answered ${res.status} without saying whether the test went out. Check its log.`,
    };
  }
  return describeTestAlertAnswer(route.fn, body.test);
}

/** The app-side name of the secret a function checks. */
function cronSecretEnvOf(fn: string): string {
  return Object.values(SYNC_NUDGE).find((n) => n.fn === fn)?.env ?? "cron secret";
}
