import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { sendTestAlert, testAlertProblem } from "@/lib/admin/test-alert";
import { enforceRateLimit } from "@/lib/rate-limit";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * POST: have a scheduled sync function send one test message to the alert
 * channel, so the test uses the settings real alerts use (test-alert.ts).
 * POST only, so a GET (a prefetch, a crawler, a pasted link) never sends
 * anything. Platform admins only, checked here on the server, and throttled
 * per admin so the button cannot be turned into a way to flood the channel.
 * The webhook address never appears in the answer.
 */
export async function POST() {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;

  const problem = testAlertProblem();
  if (problem) return NextResponse.json({ ok: false, error: problem }, { status: 503 });

  const throttled = await enforceRateLimit(
    "testAlert",
    ctx.user.id,
    "A few test alerts were just sent. Wait a few minutes before sending another.",
  );
  if (throttled) return throttled;

  const result = await sendTestAlert(ctx.user.email ?? null);

  // With the admin's own session, so the audit line names who asked. The
  // function's own answer is recorded by the function (alert.channel_test).
  const { error } = await ctx.ssr.rpc("platform_log_event", {
    p_event_type: "alert.test_sent",
    p_entity_type: "alert",
    p_entity_id: "test",
    p_detail: { via: result.fn, sent: result.sent },
  });
  if (error) console.error(JSON.stringify({ fn: "testAlert", step: "audit", error: error.message }));

  if (!result.sent) return NextResponse.json({ ok: false, error: result.error, fn: result.fn }, { status: 502 });
  return NextResponse.json({ ok: true, fn: result.fn, minSeverity: result.minSeverity });
}
