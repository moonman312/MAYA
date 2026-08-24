/**
 * MAYA Rules Engine — Deno-portable barrel export for Edge Functions.
 * Mirrors src/lib/engine/index.ts.
 */

export { evaluateHotel } from "./evaluate.ts";
export type { EvaluationResult } from "./evaluate.ts";

export { ruleScopeMatches } from "./scope.ts";
export { computeDta, computeOccupancy, computeNetPickup, computeRuleMetrics } from "./metrics.ts";
export { ruleConditionsMatch, conditionCount } from "./conditions.ts";

export { evaluateLadderTriple, flushLadderWrites, loadLadderStates, newLadderWriteBuffer } from "./ladder.ts";
export type { LadderPassResult, LadderStateRow } from "./ladder.ts";

export {
  basePriceKey,
  loadLastAppliedByRuleDate,
  pickupTieBreakTrace,
  resolveBaselineTs,
  runPickupPass,
  selectPickupWinner,
} from "./pickup.ts";

export {
  applyAdjustments,
  assemblePrice,
  clampPrice,
  flushPublishedPrices,
  indexActiveLadderEffects,
  loadActivePickupEffectsForRange,
  publishDecision,
} from "./pricing.ts";
export type { AssembledPrice, PublishRow } from "./pricing.ts";

export { buildAuditRow, flushAuditRows } from "./audit.ts";

export { buildBaselineSnapshotStore, snapshotCurrentState, purgeOldSnapshots } from "./snapshots.ts";
export type { BaselineSnapshotStore, CellSnapshot } from "./snapshots.ts";

export type {
  RuleMetrics,
  AdjustmentSpec,
  PickupCandidate,
  LadderTransitionAction,
  SnapshotRow,
  RoomTypeRow,
} from "./types.ts";
