/**
 * The limiter that keeps us out of trouble with the PMS vendors.
 *
 * The failure this guards against is not a slow sync — it is Cloudbeds
 * suspending a property's credentials, which their FAQ says takes an email and a
 * manual reactivation to undo, and which would look to the hotel like MAYA
 * simply stopped working.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquire,
  budgetFor,
  DEFAULT_BUDGET,
  PMS_RATE_BUDGETS,
  PmsCircuitOpen,
  record,
  resetRateLimiterForTest,
} from "@/lib/pms/rate-limit";

beforeEach(() => {
  resetRateLimiterForTest();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the budgets stay under what the vendors publish", () => {
  it("keeps Cloudbeds under 5 requests a second", () => {
    // Documented: 5/s for a property or group account. Exceeding it can suspend
    // the credentials until a human at Cloudbeds turns them back on.
    const perSecond = 1000 / PMS_RATE_BUDGETS.cloudbeds.minIntervalMs;
    expect(perSecond).toBeLessThan(5);
  });

  it("keeps Mews under 200 requests per 30 seconds", () => {
    // Documented: 200 per AccessToken per rolling 30s. We cannot see where their
    // window starts, so the margin has to absorb an unluckily-aligned burst.
    const { minIntervalMs, burst } = PMS_RATE_BUDGETS.mews;
    expect((30_000 / minIntervalMs)).toBeLessThan(200);
    expect(burst).toBeLessThan(200);
  });

  it("is most cautious with the PMS that publishes no limit", () => {
    // An integration nobody has rate-limited us on is one we have not been
    // noticed by yet.
    expect(PMS_RATE_BUDGETS.think.minIntervalMs).toBeGreaterThan(
      PMS_RATE_BUDGETS.cloudbeds.minIntervalMs,
    );
    expect(budgetFor("something-we-have-not-built-yet")).toBe(DEFAULT_BUDGET);
  });
});

describe("pacing", () => {
  it("spaces consecutive calls on one credential", async () => {
    const t0 = Date.now();
    await acquire("cloudbeds", "hotel-1");
    await acquire("cloudbeds", "hotel-1");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(PMS_RATE_BUDGETS.cloudbeds.minIntervalMs - 5);
  });

  it("does not make one hotel wait for another", async () => {
    // The budget is per credential, which is what lets the fleet grow: each new
    // hotel brings its own allowance instead of dividing everyone else's.
    await acquire("cloudbeds", "hotel-1");
    const t0 = Date.now();
    await acquire("cloudbeds", "hotel-2");
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("keeps separate budgets per PMS", async () => {
    await acquire("cloudbeds", "same-key");
    const t0 = Date.now();
    await acquire("mews", "same-key");
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe("the circuit breaker", () => {
  it("parks a credential after repeated throttling", () => {
    // Continuing to trickle requests at a credential that keeps being refused is
    // exactly what turns rate limiting into suspension.
    const { breakerThreshold } = PMS_RATE_BUDGETS.cloudbeds;
    for (let i = 0; i < breakerThreshold; i++) record("cloudbeds", "hotel-1", "throttled");
    return expect(acquire("cloudbeds", "hotel-1")).rejects.toBeInstanceOf(PmsCircuitOpen);
  });

  it("resets the count on any success, so occasional 429s never trip it", async () => {
    record("cloudbeds", "hotel-1", "throttled");
    record("cloudbeds", "hotel-1", "throttled");
    record("cloudbeds", "hotel-1", "ok");
    record("cloudbeds", "hotel-1", "throttled");
    await expect(acquire("cloudbeds", "hotel-1")).resolves.toBeUndefined();
  });

  it("parks only the credential that was refused", async () => {
    for (let i = 0; i < PMS_RATE_BUDGETS.cloudbeds.breakerThreshold; i++) {
      record("cloudbeds", "hotel-1", "throttled");
    }
    // One hotel's bad token must not stop the rest of the fleet syncing.
    await expect(acquire("cloudbeds", "hotel-2")).resolves.toBeUndefined();
  });

  it("says how long the caller should wait", async () => {
    for (let i = 0; i < PMS_RATE_BUDGETS.cloudbeds.breakerThreshold; i++) {
      record("cloudbeds", "hotel-1", "throttled");
    }
    await acquire("cloudbeds", "hotel-1").catch((e: PmsCircuitOpen) => {
      expect(e.retryInMs).toBeGreaterThan(0);
      expect(e.retryInMs).toBeLessThanOrEqual(PMS_RATE_BUDGETS.cloudbeds.breakerCooldownMs);
      expect(e.pmsType).toBe("cloudbeds");
    });
  });
});
