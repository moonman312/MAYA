/**
 * Cron entry point for the 48-hour card re-check (see lib/billing/reverify.ts).
 *
 * Machine-only. There is no signed-in path in here on purpose: the sweep writes
 * hotel_subscriptions with the service-role client, which RLS revokes from
 * `authenticated` precisely so that nothing a logged-in user can reach decides
 * what their billing row says. A shared secret in a header is the whole
 * authorization, so a missing secret means the route is down rather than open.
 */

import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { isStripeConfigured, stripeClient } from "@/lib/billing/stripe";
import { sweepCardReverification } from "@/lib/billing/reverify";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full batch is ~2 Stripe round trips per hotel, run sequentially.
export const maxDuration = 60;

const SECRET_HEADER = "x-billing-cron-secret";

/**
 * Compared byte-for-byte in constant time. A `!==` on a secret leaks its length
 * and, in principle, its prefix to anyone willing to time enough requests.
 */
function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const secret = process.env.BILLING_CRON_SECRET;
  if (!secret) {
    console.error(JSON.stringify({ fn: "cardReverifyRoute", error: "BILLING_CRON_SECRET missing" }));
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (!secretMatches(request.headers.get(SECRET_HEADER), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isStripeConfigured() || !isAdminConfigured()) {
    return NextResponse.json({ error: "Billing is not configured" }, { status: 503 });
  }

  const result = await sweepCardReverification({
    admin: createAdminClient(),
    stripe: stripeClient(),
  });

  // 200 even with errors in the batch: the failures are per-hotel and already
  // logged, and a non-2xx would tell pg_cron the whole sweep needs replaying.
  return NextResponse.json({ ok: true, ...result });
}
