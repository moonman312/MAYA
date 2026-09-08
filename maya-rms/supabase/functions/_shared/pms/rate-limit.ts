/**
 * Staying inside other people's rate limits.
 *
 * Being throttled by a PMS is not a degraded experience, it is an outage for
 * every hotel on that PMS at once — and with Cloudbeds it is worse than an
 * outage, because their documented response to sustained abuse is suspending the
 * credentials until a human at their end turns them back on.
 *
 * Documented limits, checked July 2026:
 *
 *   Cloudbeds  5 req/s for a property or group account, 10 for a tech partner.
 *              Exceeding it "may result in a temporary suspension of a user's
 *              API credentials", cleared by email and manual reactivation.
 *              https://developers.cloudbeds.com/docs/faq
 *
 *   Mews       200 requests per AccessToken per 30 seconds, enforced as a
 *              SLIDING window anchored on the first request of a burst — not on
 *              clock boundaries. 429 carries Retry-After. Mews state plainly
 *              that they do not raise limits and that integrations are expected
 *              to bring their own rate limiting, backoff and circuit breakers.
 *              https://docs.mews.com/connector-api/guidelines/environments
 *
 * Both are scoped to the CREDENTIAL, and MAYA holds one per property, so the
 * budget below is per hotel. That is what makes the fleet scale: adding hotels
 * adds budget rather than dividing it. What it does NOT protect against is our
 * own concurrency — see maxConcurrentHotels in the scheduled functions, which is
 * the other half of this.
 */

export type PmsRateBudget = {
  /** Smallest gap between two calls on one credential. */
  minIntervalMs: number;
  /** Requests allowed in `windowMs`, where the vendor enforces a window. */
  burst: number;
  windowMs: number;
  /** Consecutive 429s before this credential is parked. */
  breakerThreshold: number;
  /** How long a tripped breaker stays open. */
  breakerCooldownMs: number;
};

/**
 * Deliberately below every documented ceiling. The headroom is not timidity: the
 * limits are enforced on the vendor's clock, not ours, and network jitter means
 * requests we spaced correctly can still arrive bunched. Mews say outright that
 * their limit is "a guideline, not a strict guarantee in either direction".
 */
export const PMS_RATE_BUDGETS: Record<string, PmsRateBudget> = {
  // 4.5 req/s against a documented 5. One call in ten is free headroom.
  cloudbeds: {
    minIntervalMs: 220,
    burst: 5,
    windowMs: 1_000,
    breakerThreshold: 3,
    breakerCooldownMs: 60_000,
  },
  // 200 per 30s is 6.67/s. 175ms is 5.7/s, which is 171 in any 30s window —
  // comfortably inside a sliding window we cannot see the start of.
  mews: {
    minIntervalMs: 175,
    burst: 170,
    windowMs: 30_000,
    breakerThreshold: 3,
    breakerCooldownMs: 60_000,
  },
  // Think Reservations publishes no limit. Until one is confirmed this is the
  // most conservative entry here: 2 req/s, on the principle that an integration
  // nobody has rate-limited us on is one we have not yet been noticed by.
  think: {
    minIntervalMs: 500,
    burst: 2,
    windowMs: 1_000,
    breakerThreshold: 3,
    breakerCooldownMs: 120_000,
  },
};

export const DEFAULT_BUDGET: PmsRateBudget = PMS_RATE_BUDGETS.think;

export function budgetFor(pmsType: string): PmsRateBudget {
  return PMS_RATE_BUDGETS[pmsType] ?? DEFAULT_BUDGET;
}

type Lane = {
  lastAt: number;
  /** Timestamps inside the current window, oldest first. */
  recent: number[];
  consecutive429: number;
  breakerUntil: number;
};

/**
 * One lane per credential.
 *
 * Module state, which means per isolate. That is correct for the per-credential
 * budget — a given hotel is synced by one invocation at a time — and is exactly
 * why the fleet also needs a concurrency cap: twenty isolates each pacing
 * perfectly still make twenty times the requests if they are all hitting the
 * same vendor. The cap is the global half; this is the per-hotel half.
 */
const lanes = new Map<string, Lane>();

function lane(key: string): Lane {
  let l = lanes.get(key);
  if (!l) {
    l = { lastAt: 0, recent: [], consecutive429: 0, breakerUntil: 0 };
    lanes.set(key, l);
  }
  return l;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PmsCircuitOpen extends Error {
  constructor(
    readonly pmsType: string,
    readonly retryInMs: number,
  ) {
    super(`${pmsType} rate limiter is cooling down for ${Math.ceil(retryInMs / 1000)}s`);
    this.name = "PmsCircuitOpen";
  }
}

/**
 * Wait until this credential may make another call.
 *
 * Enforces both the minimum gap and the window budget, because they catch
 * different mistakes: the gap stops a tight loop, and the window stops a burst
 * that respects the gap but still overruns a 30-second allowance.
 *
 * Throws PmsCircuitOpen rather than sleeping when the breaker has tripped. A
 * credential that has been 429'd repeatedly should stop being called at all for
 * a while — continuing to trickle requests at it is what turns rate limiting
 * into suspension.
 */
export async function acquire(pmsType: string, credentialKey: string): Promise<void> {
  const budget = budgetFor(pmsType);
  const l = lane(`${pmsType}:${credentialKey}`);
  const now = Date.now();

  if (l.breakerUntil > now) throw new PmsCircuitOpen(pmsType, l.breakerUntil - now);

  // Drop anything that has aged out of the window before counting.
  const windowStart = now - budget.windowMs;
  l.recent = l.recent.filter((t) => t > windowStart);

  let waitMs = Math.max(0, l.lastAt + budget.minIntervalMs - now);
  if (l.recent.length >= budget.burst) {
    // Full: wait for the oldest request to leave the window.
    waitMs = Math.max(waitMs, l.recent[0] + budget.windowMs - now + 1);
  }
  if (waitMs > 0) await sleep(waitMs);

  const at = Date.now();
  l.lastAt = at;
  l.recent.push(at);
}

/** Call after a request resolves so the breaker can see a run of refusals. */
export function record(pmsType: string, credentialKey: string, outcome: "ok" | "throttled"): void {
  const l = lane(`${pmsType}:${credentialKey}`);
  if (outcome === "ok") {
    l.consecutive429 = 0;
    return;
  }
  l.consecutive429 += 1;
  const budget = budgetFor(pmsType);
  if (l.consecutive429 >= budget.breakerThreshold) {
    l.breakerUntil = Date.now() + budget.breakerCooldownMs;
    l.consecutive429 = 0;
    console.error(
      JSON.stringify({
        fn: "pmsRateLimit",
        pmsType,
        event: "circuit_open",
        cooldownMs: budget.breakerCooldownMs,
      }),
    );
  }
}

/** Test seam: lanes are process-lifetime and must not leak between tests. */
export function resetRateLimiterForTest(): void {
  lanes.clear();
}
