import "server-only";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { NextResponse } from "next/server";

/**
 * Throttling our own API.
 *
 * There was none. Every expensive endpoint — starting a checkout, validating a
 * signup code, triggering a PMS sync — could be called in a loop by anyone with
 * an account, and the PMS sync in particular spends someone else's rate limit
 * on our credentials.
 *
 * Backed by Postgres rather than Redis. At this size a second piece of
 * infrastructure is a second thing to run, pay for, and have fail; one upsert
 * against an indexed table is cheap enough to be invisible next to the work
 * these routes actually do.
 *
 * Fails OPEN. A limiter that takes the product down when the counter is
 * unavailable has done more damage than the abuse it was guarding against.
 */

export type RateLimitRule = {
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
};

/**
 * Named budgets, sized by what the endpoint costs us rather than by feel.
 *
 * The two that matter are pmsSync — every call spends the hotel's Cloudbeds or
 * Mews allowance, and exhausting that is what gets credentials suspended — and
 * codeCheck, which is the one endpoint an attacker would use to guess signup
 * codes.
 */
export const RATE_LIMITS = {
  /** Hand-triggered PMS sync. Generous for a human, useless for a loop. */
  pmsSync: { limit: 6, windowSeconds: 300 },
  /** Signup code validation: enough to fix a typo, not enough to search. */
  codeCheck: { limit: 20, windowSeconds: 600 },
  /** Starting a Stripe Checkout session. */
  checkout: { limit: 10, windowSeconds: 600 },
  /** Inviting teammates. Bounded by seats anyway; this stops the email spray. */
  invite: { limit: 20, windowSeconds: 3600 },
  /** Re-running onboarding analysis, which re-reads a lot of history. */
  reanalyse: { limit: 5, windowSeconds: 900 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export type RateLimitResult = {
  allowed: boolean;
  hits: number;
  limit: number;
  resetsAt: string | null;
};

/**
 * Count one request against a bucket.
 *
 * The subject is usually a user id. It must never be something the caller
 * controls — an IP header can be spoofed, and a per-account limit that a
 * request can rename itself out of is decoration.
 */
export async function rateLimit(
  name: RateLimitName,
  subject: string,
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name];
  if (!isAdminConfigured()) {
    return { allowed: true, hits: 0, limit: rule.limit, resetsAt: null };
  }

  try {
    const { data, error } = await createAdminClient()
      .rpc("rate_limit_hit", {
        p_key: `${name}:${subject}`,
        p_limit: rule.limit,
        p_window_seconds: rule.windowSeconds,
      })
      .maybeSingle();

    if (error || !data) {
      console.error(JSON.stringify({ fn: "rateLimit", name, error: error?.message ?? "no_row" }));
      return { allowed: true, hits: 0, limit: rule.limit, resetsAt: null };
    }

    const row = data as { allowed: boolean; hits: number; resets_at: string };
    return {
      allowed: row.allowed,
      hits: row.hits,
      limit: rule.limit,
      resetsAt: row.resets_at,
    };
  } catch (e) {
    console.error(
      JSON.stringify({ fn: "rateLimit", name, error: e instanceof Error ? e.message : String(e) }),
    );
    return { allowed: true, hits: 0, limit: rule.limit, resetsAt: null };
  }
}

/**
 * The 429 to return, with the headers a well-behaved client reads.
 *
 * Retry-After is not decoration: it is the difference between a client backing
 * off and a client hammering us harder because it thinks something broke.
 */
export function tooManyRequests(result: RateLimitResult, message?: string): NextResponse {
  const retryAfterSeconds = result.resetsAt
    ? Math.max(1, Math.ceil((Date.parse(result.resetsAt) - Date.now()) / 1000))
    : 60;

  return NextResponse.json(
    { error: message ?? "That's a bit fast — try again shortly.", retryAfterSeconds },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(Math.max(0, result.limit - result.hits)),
      },
    },
  );
}

/**
 * Guard a route in one line. Returns a response to return, or null to continue.
 */
export async function enforceRateLimit(
  name: RateLimitName,
  subject: string,
  message?: string,
): Promise<NextResponse | null> {
  const result = await rateLimit(name, subject);
  return result.allowed ? null : tooManyRequests(result, message);
}
