/**
 * PMS connection health classification over recent pms_request_log traffic.
 * Pure so the activity API and any dashboard widget share one definition.
 */

export type PmsHealthState = "healthy" | "degraded" | "down" | "unknown";

export type PmsHealth = {
  state: PmsHealthState;
  successRate: number | null;
  total: number;
  failures: number;
};

export const PMS_HEALTHY_MIN_SUCCESS_RATE = 0.98;
export const PMS_DEGRADED_MIN_SUCCESS_RATE = 0.8;

/**
 * Classify PMS health from request counts in the observation window:
 * no traffic → unknown; success rate ≥98% → healthy; ≥80% → degraded;
 * anything below → down.
 */
export function classifyPmsHealth(total: number, failures: number): PmsHealth {
  if (total <= 0) {
    return { state: "unknown", successRate: null, total: 0, failures: 0 };
  }
  const successRate = (total - failures) / total;
  const state: PmsHealthState =
    successRate >= PMS_HEALTHY_MIN_SUCCESS_RATE
      ? "healthy"
      : successRate >= PMS_DEGRADED_MIN_SUCCESS_RATE
        ? "degraded"
        : "down";
  return { state, successRate, total, failures };
}
