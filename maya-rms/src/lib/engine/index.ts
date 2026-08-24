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

export { evaluateLadderTriple, flushLadderWrites, loadLadderStates, newLadderWriteBuffer } from "./ladder";
export type { LadderPassResult, LadderStateRow } from "./ladder";

export {
  basePriceKey,
  loadLastAppliedByRuleDate,
  pickupTieBreakTrace,
  resolveBaselineTs,
  runPickupPass,
  selectPickupWinner,
} from "./pickup";

export {
  applyAdjustments,
  assemblePrice,
  clampPrice,
  flushPublishedPrices,
  ladderEffectsForCell,
  loadActivePickupEffectsForRange,
  publishDecision,
} from "./pricing";
export type { AssembledPrice, PublishRow } from "./pricing";

export { buildAuditRow, flushAuditRows } from "./audit";

export { buildBaselineSnapshotStore, snapshotCurrentState, purgeOldSnapshots } from "./snapshots";
export type { BaselineSnapshotStore, CellSnapshot } from "./snapshots";

export type {
  RuleMetrics,
  AdjustmentSpec,
  PickupCandidate,
  LadderTransitionAction,
  SnapshotRow,
  RoomTypeRow,
} from "./types";
