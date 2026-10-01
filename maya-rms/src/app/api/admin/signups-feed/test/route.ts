import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { sendSignupsFeedTest } from "@/lib/admin/signups-feed";
import { enforceRateLimit } from "@/lib/rate-limit";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * POST: one test line to #maya-signups, posted by the database through the
 * same webhook real signups use (signup_feed_test, lib/admin/signups-feed.ts).
 * POST only, so a prefetch or a pasted link never sends anything. Platform
 * admins only, here and again in the database, and throttled per admin. The
 * webhook address never reaches the app.
 */
export async function POST() {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;

  const throttled = await enforceRateLimit(
    "signupsFeedTest",
    ctx.user.id,
    "A few test lines were just sent. Wait a few minutes before sending another.",
  );
  if (throttled) return throttled;

  // The admin's own session: the function checks is_platform_admin() itself.
  const result = await sendSignupsFeedTest(ctx.ssr);

  const { error } = await ctx.ssr.rpc("platform_log_event", {
    p_event_type: "signups_feed.test_sent",
    p_entity_type: "alert",
    p_entity_id: "signups-feed",
    p_detail: { sent: result.sent },
  });
  if (error) console.error(JSON.stringify({ fn: "signupsFeedTest", step: "audit", error: error.message }));

  if (!result.sent) return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true });
}
