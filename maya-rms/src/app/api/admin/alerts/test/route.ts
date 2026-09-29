import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { sendTestAlert, testAlertProblem } from "@/lib/admin/test-alert";
import { enforceRateLimit } from "@/lib/rate-limit";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * POST: send one test message to the alert channel. POST only, so a GET (a
 * prefetch, a crawler, a pasted link) never sends anything. Platform admins
 * only, checked here on the server, and throttled per admin so the button
 * cannot be turned into a way to flood the channel. The webhook address never
 * appears in the answer.
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
  if (!result.sent) return NextResponse.json({ ok: false, error: result.error }, { status: 502 });

  // With the admin's own session, so the audit line names who sent it.
  const { error } = await ctx.ssr.rpc("platform_log_event", {
    p_event_type: "alert.test_sent",
    p_entity_type: "alert",
    p_entity_id: "test",
    p_detail: {},
  });
  if (error) console.error(JSON.stringify({ fn: "testAlert", step: "audit", error: error.message }));

  return NextResponse.json({ ok: true });
}
