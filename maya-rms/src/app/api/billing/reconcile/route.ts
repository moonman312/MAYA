/**
 * Cron entry point for the nightly Stripe check (see lib/billing/reconcile.ts):
 * every subscription on record re-read from Stripe and corrected, for the day
 * Stripe's messages stop reaching the webhook.
 *
 * Machine-only, behind the same shared secret as the card check and room-count
 * truing (lib/billing/cron-guard.ts). It writes hotel_subscriptions, which
 * decides who MAYA works for, so nothing signed-in has a path in.
 */

import { createAdminClient } from "@/utils/supabase/admin";
import { stripeClient } from "@/lib/billing/stripe";
import { guardBillingCron } from "@/lib/billing/cron-guard";
import { sweepStripeReconcile } from "@/lib/billing/reconcile";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The sweep stops starting new reads after 45 seconds and carries on next run.
export const maxDuration = 60;

export async function POST(request: Request) {
  const refused = await guardBillingCron(request, "stripeReconcileRoute");
  if (refused) return refused;

  const result = await sweepStripeReconcile({
    admin: createAdminClient(),
    stripe: stripeClient(),
    now: new Date(),
  });

  // 200 even with per-property failures: they are logged and handed to a
  // person, and a non-2xx would only make pg_cron's log noisier.
  return NextResponse.json({ ok: true, ...result });
}
