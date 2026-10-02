/**
 * Cron entry point for the 48-hour card re-check (see lib/billing/reverify.ts).
 *
 * Machine-only. There is no signed-in path in here on purpose: the sweep writes
 * hotel_subscriptions with the service-role client, which RLS revokes from
 * `authenticated` precisely so that nothing a logged-in user can reach decides
 * what their billing row says. A shared secret in a header is the whole
 * authorization, so a missing secret means the route is down rather than open.
 */

import { createAdminClient } from "@/utils/supabase/admin";
import { stripeClient } from "@/lib/billing/stripe";
import { guardBillingCron } from "@/lib/billing/cron-guard";
import { sweepCardReverification } from "@/lib/billing/reverify";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full batch is ~2 Stripe round trips per hotel, run sequentially.
export const maxDuration = 60;

export async function POST(request: Request) {
  const refused = await guardBillingCron(request, "cardReverifyRoute");
  if (refused) return refused;

  const result = await sweepCardReverification({
    admin: createAdminClient(),
    stripe: stripeClient(),
  });

  // 200 even with errors in the batch: the failures are per-hotel and already
  // logged, and a non-2xx would tell pg_cron the whole sweep needs replaying.
  return NextResponse.json({ ok: true, ...result });
}
