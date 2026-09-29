/**
 * Thin re-export of the strategy projection helper (canonical implementation
 * lives in supabase/functions/_shared/onboarding/project-strategy.ts so the
 * import worker can re-project after the import finishes).
 */
export {
  describeGuardrailNotSaved,
  projectStrategyOntoRoomTypes,
  type GuardrailNotSaved,
} from "../../../supabase/functions/_shared/onboarding/project-strategy";
