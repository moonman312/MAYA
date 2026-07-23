/**
 * MAYA Rules Engine — Deno-portable barrel export for Edge Functions.
 * Mirrors src/lib/engine/index.ts.
 */

export { evaluateHotel } from "./evaluate.ts";
export type { EvaluationResult } from "./evaluate.ts";

export { ruleScopeMatches } from "./scope.ts";
export { computeDta, computeOccupancy, computeNetPickup, computeRuleMetrics } from "./metrics.ts";
export { ruleConditionsMatch, conditionCount } from "./conditions.ts";

export { evaluateLadderTriple } from "./ladder.ts";
export type { LadderPassResult } from "./ladder.ts";

export {
  basePriceKey,
  computeBaselineTs,
  pickupTieBreakTrace,
  runPickupPass,
  selectPickupWinner,
} from "./pickup.ts";

export { applyAdjustments, clampPrice, assemblePrice, maybePublish } from "./pricing.ts";
export type { AssembledPrice } from "./pricing.ts";

export { writeAudit } from "./audit.ts";

export { snapshotCurrentState, findSnapshotAt, purgeOldSnapshots } from "./snapshots.ts";

export type {
  RuleMetrics,
  AdjustmentSpec,
  PickupCandidate,
  LadderTransitionAction,
  SnapshotRow,
  RoomTypeRow,
} from "./types.ts";
