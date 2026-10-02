import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isStripeConfigured } from "@/lib/billing/stripe";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { HOUR_MS, recordBillingProblem } from "./problems";

/**
 * The door of every billing cron route (card check, room-count truing, the
 * nightly Stripe check): pg_cron posts with the shared secret in
 * x-billing-cron-secret, and nothing signed-in has a way in. A missing secret
 * means the route is down rather than open.
 *
 * Down is also a billing problem a person has to hear about: the jobs stop
 * and nothing else says so. Each refusal for a missing setting is handed to
 * the billing watchdog (problems.ts), at most every 6 hours, when the service
 * role is there to write it. The watchdog also says when a job stops
 * reporting runs, which covers the cases this cannot see (the cron never
 * calls, the Vault secret is wrong).
 */

const SECRET_HEADER = "x-billing-cron-secret";

/** Constant time: a `!==` on a secret leaks its length to a patient caller. */
function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function tellAPerson(key: string, title: string, detail: string): Promise<void> {
  if (!isAdminConfigured()) return;
  try {
    await recordBillingProblem(createAdminClient(), { key, title, detail }, { quietForMs: 6 * HOUR_MS });
  } catch {
    // recordBillingProblem never throws; the client constructor is the only thing that could.
  }
}

/** Null when the request may run the job, else the answer to give. */
export async function guardBillingCron(request: Request, fn: string): Promise<NextResponse | null> {
  const secret = process.env.BILLING_CRON_SECRET;
  if (!secret) {
    console.error(JSON.stringify({ fn, error: "BILLING_CRON_SECRET missing" }));
    await tellAPerson(
      "billing-cron-secret-missing",
      "The billing jobs are refused: BILLING_CRON_SECRET is not set",
      `${fn} answered 503 because BILLING_CRON_SECRET is not set in the app. The card check, room-count truing ` +
        "and the nightly Stripe check do not run until it is. Set it in Vercel to the Vault secret billing_cron_secret.",
    );
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (!secretMatches(request.headers.get(SECRET_HEADER), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isStripeConfigured() || !isAdminConfigured()) {
    console.error(JSON.stringify({ fn, error: "billing not configured", stripe: isStripeConfigured(), admin: isAdminConfigured() }));
    await tellAPerson(
      "billing-cron-not-configured",
      "The billing jobs are refused: the app has no Stripe key",
      `${fn} answered 503 because STRIPE_SECRET_KEY is not set in the app, so no billing job runs. Set it in Vercel.`,
    );
    return NextResponse.json({ error: "Billing is not configured" }, { status: 503 });
  }
  return null;
}
