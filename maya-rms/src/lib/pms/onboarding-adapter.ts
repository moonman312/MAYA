/**
 * Thin re-export of the PMS onboarding adapter layer (canonical implementation
 * lives in supabase/functions/_shared/pms/onboarding-adapter.ts).
 * Mirrors src/lib/cloudbeds/sync-hotel.ts.
 */
export {
  createOnboardingAdapter,
} from "../../../supabase/functions/_shared/pms/onboarding-adapter";
export type {
  AdapterCursor,
  AdapterReservationRow,
  AdapterRoomType,
  OnboardingPmsAdapter,
  PmsPropertyProfile,
  PreResolvedOAuthCredentials,
} from "../../../supabase/functions/_shared/pms/onboarding-adapter";
