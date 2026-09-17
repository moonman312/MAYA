/**
 * PMS-agnostic adapter interface for the onboarding flow.
 *
 * Onboarding needs four things from any PMS: who the property is, what its
 * room types are, and its reservation history (a slim, checkpointed pull of
 * multi-year history a page at a time, plus the live sync over the current
 * window).
 * Implement this interface for a new PMS and the entire onboarding flow —
 * hotel auto-creation, background import, cleaning, analysis — works with
 * zero changes elsewhere. Register the implementation in
 * `createOnboardingAdapter` below and flip `onboardingSupported` in
 * src/lib/pms/registry.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOAuthCredentials } from "./oauth-credentials.ts";
// Static import: the edge-function bundler only follows static imports, so a
// dynamic import() here deploys without the module and crashes at runtime.
import { createCloudbedsOnboardingAdapter } from "../cloudbeds/onboarding-adapter.ts";
import { createThinkOnboardingAdapter } from "../think/onboarding-adapter.ts";

export type PmsPropertyProfile = {
  externalPropertyId: string;
  name: string | null;
  timezone: string | null; // IANA
  currency: string | null; // ISO 4217
};

export type AdapterRoomType = {
  external_room_type_id: string;
  name: string;
  display_name: string | null;
  total_rooms: number;
};

/** One booked room-night, matching the `reservations` table shape. */
export type AdapterReservationRow = {
  external_reservation_id: string;
  external_room_type_id: string | null;
  stay_date: string; // YYYY-MM-DD
  booking_date: string | null;
  booking_window_days: number | null;
  current_rate: number | null;
  /** Already PII-redacted by the adapter. Null for slim historical rows. */
  raw_payload: Record<string, unknown> | null;
};

/** Opaque page cursor — shape is adapter-specific, persisted as JSON. */
export type AdapterCursor = Record<string, unknown>;

export type OnboardingAdapterCapabilities = {
  /** Can pull arbitrary historical windows. */
  historicalImport: boolean;
  /** List endpoint lacks per-night rates; current window needs detail calls. */
  needsDetailFetch: boolean;
};

export interface OnboardingPmsAdapter {
  readonly pmsType: string;
  readonly capabilities: OnboardingAdapterCapabilities;

  /** Property identity + metadata. Used to create the hotel record. */
  discoverProperty(): Promise<PmsPropertyProfile>;

  fetchRoomTypes(): Promise<AdapterRoomType[]>;

  /**
   * One page of slim reservation rows (dates + price, no PII) for one history
   * window. `cursor` null starts the window; returns `nextCursor` null when
   * the window is exhausted. The worker persists the cursor between calls so
   * a killed run resumes exactly where it stopped.
   *
   * `from`/`to` are inclusive stay dates, and consecutive windows tile with
   * no gap. How a booking is assigned to a window is the adapter's to keep
   * consistent: Think reads by stay date, Cloudbeds by check-out date.
   * `newest` is set on window 0, the one directly behind the current-window
   * sync (which starts the day after its `to`). An adapter whose windows are
   * not owned by check-in must also return, there, bookings that check in on
   * or before `to` and check out later — guests in house when the current
   * window starts, which a check-in-owned current window never stores.
   *
   * With `nextCursor` null an adapter may also return `nextWindowCursor`: the
   * worker starts the next (older) window with it instead of null. It is how
   * an adapter tells its next window how this one assigned bookings, so a
   * change of rule between windows (a fallback, or a deploy that lands
   * mid-import) leaves no booking between them.
   *
   * `reconcileIds` are external_reservation_ids this page speaks for in full:
   * after upserting `rows`, the worker deletes every stored night under them
   * that `rows` does not hold (a booking canceled or shortened since an
   * earlier import, or nights an older import keyed differently).
   *
   * `restartWindow` says this page reads the window again from its start, so
   * the rows its earlier pages wrote are about to be written again: the
   * worker takes them back off its counters before counting this page.
   */
  fetchReservationListPage(
    window: { from: string; to: string; newest?: boolean },
    cursor: AdapterCursor | null,
  ): Promise<{
    rows: AdapterReservationRow[];
    nextCursor: AdapterCursor | null;
    nextWindowCursor?: AdapterCursor | null;
    reconcileIds?: string[];
    restartWindow?: boolean;
  }>;
}

export type PreResolvedOAuthCredentials = {
  accessToken: string;
  tokenType: string;
  propertyId?: string | null;
};

/**
 * Factory: build the adapter for a hotel's connected PMS.
 * `preResolved` lets the OAuth callback pass freshly-minted tokens before the
 * Vault write has settled. Throws for PMS types with no onboarding support.
 */
export async function createOnboardingAdapter(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  preResolved?: PreResolvedOAuthCredentials,
): Promise<OnboardingPmsAdapter> {
  switch (pmsType) {
    case "cloudbeds":
      return createCloudbedsOnboardingAdapter(supabase, hotelId, preResolved);
    case "think":
      return createThinkOnboardingAdapter(supabase, hotelId, preResolved);
    default:
      throw new Error(
        `PMS '${pmsType}' does not support onboarding import yet. ` +
          `Implement OnboardingPmsAdapter and register it in createOnboardingAdapter.`,
      );
  }
}

export { resolveOAuthCredentials };
