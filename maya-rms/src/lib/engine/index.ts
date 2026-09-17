/**
 * MAYA Rules Engine v1 — barrel export.
 *
 * Aligned with the Rules Engine Implementation Guide.
 */

export { evaluateHotel } from "./evaluate";
export type { EvaluationResult } from "./evaluate";

export { ruleScopeMatches } from "./scope";
export { computeDta, computeOccupancy, computeNetPickup, computeRuleMetrics } from "./metrics";
export { ruleConditionsMatch, conditionCount } from "./conditions";

export { evaluateLadderTriple } from "./ladder";
export type { LadderPassResult } from "./ladder";

export {
  basePriceKey,
  baselineTsFrom,
  cancelCheckFor,
  pickupTieBreakTrace,
  ruleWaitDays,
  runPickupPass,
  selectPickupWinner,
} from "./pickup";

export { isStoppedOnNight, REPEAT_ALERT_FIRES } from "./repeat-alerts";

export { applyAdjustments, clampPrice, assemblePrice, limitAllowsFire, maybePublish } from "./pricing";
export type { AssembledPrice, PickupEffect } from "./pricing";

export { writeAudit } from "./audit";

export { snapshotCurrentState, findSnapshotAt, purgeOldSnapshots } from "./snapshots";

export type {
  RuleMetrics,
  AdjustmentSpec,
  PickupCandidate,
  LadderTransitionAction,
  SnapshotRow,
  RoomTypeRow,
} from "./types";
