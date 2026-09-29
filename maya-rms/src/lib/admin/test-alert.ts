import "server-only";
import {
  alertChannelState,
  postTestMessage,
} from "../../../supabase/functions/_shared/pms/alerting";

// "Send a test alert" on the Command Center: one message to the alert channel
// (MAYA_ALERT_WEBHOOK, our Slack), so someone can see alerts arrive without
// waiting for something to break. The webhook address stays on the server:
// nothing here returns it, and the page only learns whether it is set.

/** How long the button waits on the alert channel before saying so. */
export const TEST_ALERT_TIMEOUT_MS = 5000;

/** Why no test alert can be sent from this deployment, in plain words, or null when one can. */
export function testAlertProblem(): string | null {
  const state = alertChannelState();
  if (state === "missing") {
    return "MAYA_ALERT_WEBHOOK isn't set for this app, so there's nowhere to send alerts. Add it to the app's environment variables in Vercel, then redeploy.";
  }
  if (state === "not_https") {
    return "MAYA_ALERT_WEBHOOK is set for this app, but it isn't an https:// address, so MAYA won't send to it. Fix it in Vercel, then redeploy.";
  }
  return null;
}

export type TestAlertResult = { sent: true } | { sent: false; error: string };

/** Post the one test message. Never throws. */
export async function sendTestAlert(sentBy: string | null): Promise<TestAlertResult> {
  const text =
    `🧪 Test alert from the MAYA Command Center${sentBy ? `, sent by ${sentBy}` : ""}. ` +
    "If you can read this, alerts reach this channel.";
  const res = await postTestMessage(text, TEST_ALERT_TIMEOUT_MS);
  if (res.sent) return { sent: true };
  if (res.reason === "no_webhook_configured") return { sent: false, error: testAlertProblem() ?? "The alert channel isn't set up." };
  if (res.reason === "timeout") {
    return {
      sent: false,
      error: `The alert channel didn't answer within ${TEST_ALERT_TIMEOUT_MS / 1000} seconds, so the test may not have arrived.`,
    };
  }
  if (res.reason?.startsWith("webhook_")) {
    return {
      sent: false,
      error: `The alert channel refused the message (HTTP ${res.reason.slice("webhook_".length)}). Check that MAYA_ALERT_WEBHOOK is still a live webhook.`,
    };
  }
  return { sent: false, error: "Couldn't reach the alert channel. Try again in a moment." };
}
