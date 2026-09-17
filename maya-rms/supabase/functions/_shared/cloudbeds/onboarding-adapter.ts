/**
 * Cloudbeds implementation of OnboardingPmsAdapter.
 *
 * History comes from getReservationsWithRateDetails, the endpoint the live
 * sync reads its own window with: a hundred whole bookings per call, every
 * room with its own room type and per-night rates. One call per page, and the
 * cursor is that page number, so a killed run resumes on the exact page it
 * stopped on. A property whose account refuses rate details falls back to the
 * getReservations list, one status at a time, which is the only path that
 * still spreads a booking's total evenly across its nights and rooms.
 *
 * Windows are owned by CHECK-OUT date, because that is the only stay-date
 * filter the endpoint honours (it silently ignores status and every check-in
 * filter). See cloudbedsHistoryWindowOwns in etl.ts for the rule and
 * historicalWindow in onboarding/worker-core.ts for the dates.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdapterCursor,
  AdapterReservationRow,
  AdapterRoomType,
  OnboardingPmsAdapter,
  PmsPropertyProfile,
  PreResolvedOAuthCredentials,
} from "../pms/onboarding-adapter.ts";
import { resolveOAuthCredentials, persistPropertyId } from "../pms/oauth-credentials.ts";
import { AmbiguousGroupGrantError } from "../pms/errors.ts";
import {
  cloudbedsDiscoverPropertyId,
  cloudbedsGetHotelDetails,
  cloudbedsListProperties,
  cloudbedsGetReservationsPage,
  cloudbedsGetReservationsWithRateDetailsPage,
  cloudbedsGetRoomTypes,
  type CloudbedsRateDetailsQuery,
} from "./client.ts";
import {
  parseCloudbedsHistoryRateDetails,
  parseCloudbedsReservations,
  parseCloudbedsRoomTypes,
  type CloudbedsHistoryWindow,
} from "./etl.ts";
import {
  CLOUDBEDS_ACTIVE_STATUSES,
  CLOUDBEDS_CANCELED_STATUSES,
  defaultCloudbedsBaseUrl,
} from "./constants.ts";
import { installCloudbedsRequestLogging } from "./request-log.ts";
import { cloudbedsRateDetailsRefused } from "./rate-details-refusal.ts";
import type { CloudbedsResolvedCredentials } from "./types.ts";

/**
 * The cursor, persisted as import_jobs.enum_cursor between pages.
 *
 *   null                                   start of a window, the one before it unknown
 *   { after: "checkout" | "checkin" }      start of a window, handed over by the
 *                                          window before it (nextWindowCursor)
 *   { pageNumber, openEnd? }               rate details, the page to read next
 *   { path: "list", statusIndex, pageNumber }
 *                                          the list fallback, mid-window
 *   { statusIndex, pageNumber }            written by the list-only deploy
 *
 * The page number is the only position. `openEnd` is not a position: it
 * records which query this window is paging through, so page 3 asks the same
 * question pages 1 and 2 did.
 *
 * A window is open-ended (see CloudbedsHistoryWindow) when it is window 0, or
 * when the newer window before it was not owned by check-out: one read by
 * check-in on the list, or one the list-only deploy imported. A window
 * starting from null is treated as the latter, because the only jobs that
 * start a window after 0 without a handover are ones whose earlier windows
 * that deploy read. Without this, a booking that checks in inside this window
 * and out inside the newer one would belong to neither.
 *
 * A legacy mid-window cursor cannot be mapped onto rate-details pages: those
 * listed one status at a time and these list every status at once, in an
 * order nothing relates. So the window restarts at rate-details page 1,
 * open-ended. Upserts are keyed (hotel_id, external_reservation_id,
 * stay_date), so rows the old pages wrote are overwritten in place with real
 * rates; only the job's counters count them a second time. If the property
 * refuses rate details the legacy cursor means exactly what it meant, and the
 * list fallback resumes on that status and page.
 */
type CloudbedsCursor =
  | { kind: "rate_details"; pageNumber: number; openEnd: boolean }
  | { kind: "list"; statusIndex: number; pageNumber: number; legacy: boolean };

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

export function readCloudbedsHistoryCursor(cursor: AdapterCursor | null): CloudbedsCursor {
  if (cursor && typeof cursor.statusIndex === "number" && typeof cursor.pageNumber === "number") {
    const statusIndex = Math.max(0, Math.floor(cursor.statusIndex));
    const pageNumber = Math.max(1, Math.floor(cursor.pageNumber));
    if (cursor.path === "list") return { kind: "list", statusIndex, pageNumber, legacy: false };
    return { kind: "list", statusIndex, pageNumber, legacy: true };
  }
  const pageNumber = cursor ? positiveInt(cursor.pageNumber) : null;
  if (pageNumber !== null) {
    return { kind: "rate_details", pageNumber, openEnd: cursor?.openEnd === true };
  }
  // Window start. Only a handover from a check-out-owned window closes it.
  return { kind: "rate_details", pageNumber: 1, openEnd: cursor?.after !== "checkout" };
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * The request for one history window.
 *
 * Widened by a day at each end, because nothing established whether
 * Cloudbeds treats either check-out bound as inclusive. The extra days only
 * fetch bookings a neighbouring window owns, and cloudbedsHistoryWindowOwns
 * drops them, so a booking checking out on a boundary day is read by both
 * windows and stored by one. An open-ended window has no upper bound: it also
 * owns bookings that check in on or before `to` and check out after it,
 * however long they stay.
 */
export function cloudbedsHistoryQuery(window: CloudbedsHistoryWindow): CloudbedsRateDetailsQuery {
  return {
    checkOutFrom: addDaysYmd(window.from, -1),
    checkOutTo: window.openEnd ? undefined : addDaysYmd(window.to, 1),
    excludeStatuses: CLOUDBEDS_CANCELED_STATUSES,
  };
}

export async function createCloudbedsOnboardingAdapter(
  supabase: SupabaseClient,
  hotelId: string,
  preResolved?: PreResolvedOAuthCredentials,
): Promise<OnboardingPmsAdapter> {
  // Mirror every Cloudbeds API call into pms_request_log (fire-and-forget).
  installCloudbedsRequestLogging(supabase, hotelId);

  // pms_connections.base_url wins over the env default (same as sync-hotel).
  const { data: connRow } = await supabase
    .from("pms_connections")
    .select("base_url")
    .eq("hotel_id", hotelId)
    .eq("pms_type", "cloudbeds")
    .maybeSingle();
  const baseUrl = (
    (connRow?.base_url as string | null) || defaultCloudbedsBaseUrl()
  ).replace(/\/$/, "");

  async function creds(): Promise<CloudbedsResolvedCredentials> {
    if (preResolved) {
      return {
        accessToken: preResolved.accessToken,
        tokenType: preResolved.tokenType,
        baseUrl,
        propertyId: preResolved.propertyId ?? "",
      };
    }
    const resolved = await resolveOAuthCredentials(supabase, hotelId, "cloudbeds");
    if ("error" in resolved) {
      throw new Error(`Cloudbeds credentials unavailable: ${resolved.error}`);
    }
    return {
      accessToken: resolved.accessToken,
      tokenType: resolved.tokenType,
      baseUrl,
      propertyId: resolved.propertyId ?? "",
    };
  }

  async function credsWithProperty(): Promise<CloudbedsResolvedCredentials> {
    const c = await creds();
    if (c.propertyId) return c;
    const discovered = await cloudbedsDiscoverPropertyId(c);
    if (!discovered) {
      // Discovery answers null for a group grant as well as for a broken one,
      // and the two need different words on screen: a group owner has paid and
      // done nothing wrong. The null contract stays as it is — the scheduled
      // sync relies on it — so the second look happens here.
      const properties = await cloudbedsListProperties(c);
      if (properties.length > 1) {
        throw new AmbiguousGroupGrantError(properties.length, "Cloudbeds");
      }
      throw new Error("Cloudbeds: could not discover propertyID for this account.");
    }
    await persistPropertyId(supabase, hotelId, "cloudbeds", discovered).catch(() => {
      // Non-fatal: discovery just repeats next run.
    });
    if (preResolved) preResolved.propertyId = discovered;
    return { ...c, propertyId: discovered };
  }

  /** Set once this adapter has been refused rate details, so later windows go straight to the list. */
  let refusal: string | null = null;

  /**
   * The list fallback: one page of getReservations for one status, filtered
   * by check-in over the window as the import always did. Nightly rate is the
   * booking total over (rooms x nights), and a multi-room booking whose list
   * row names no rooms is counted as one room. Kept only for accounts that
   * refuse rate details.
   */
  async function listPage(
    c: CloudbedsResolvedCredentials,
    window: { from: string; to: string },
    statusIndex: number,
    pageNumber: number,
  ): Promise<{ rows: AdapterReservationRow[]; nextCursor: AdapterCursor | null; nextWindowCursor?: AdapterCursor }> {
    if (statusIndex >= CLOUDBEDS_ACTIVE_STATUSES.length) {
      return { rows: [], nextCursor: null, nextWindowCursor: { after: "checkin" } };
    }

    const status = CLOUDBEDS_ACTIVE_STATUSES[statusIndex];
    const { reservations, hasMore } = await cloudbedsGetReservationsPage(
      c,
      window.from,
      window.to,
      status,
      pageNumber,
    );

    // Slim rows keyed the same way the detail sync keys its rows,
    // raw_payload dropped entirely.
    const parsed = parseCloudbedsReservations(reservations);
    const rows: AdapterReservationRow[] = parsed.reservations.map((r) => ({
      external_reservation_id: r.external_reservation_id,
      external_room_type_id: r.external_room_type_id,
      stay_date: r.stay_date,
      booking_date: r.booking_date,
      booking_window_days: r.booking_window_days,
      current_rate: r.current_rate,
      raw_payload: null,
    }));

    const nextCursor: AdapterCursor | null = hasMore
      ? { path: "list", statusIndex, pageNumber: pageNumber + 1 }
      : statusIndex + 1 < CLOUDBEDS_ACTIVE_STATUSES.length
        ? { path: "list", statusIndex: statusIndex + 1, pageNumber: 1 }
        : null;

    // This window was owned by check-in, so the next one has to reach forward.
    return nextCursor ? { rows, nextCursor } : { rows, nextCursor: null, nextWindowCursor: { after: "checkin" } };
  }

  return {
    pmsType: "cloudbeds",
    capabilities: { historicalImport: true, needsDetailFetch: true },

    async discoverProperty(): Promise<PmsPropertyProfile> {
      const c = await credsWithProperty();
      return await cloudbedsGetHotelDetails(c);
    },

    async fetchRoomTypes(): Promise<AdapterRoomType[]> {
      const c = await credsWithProperty();
      const raw = await cloudbedsGetRoomTypes(c);
      const { data: hotelRow } = await supabase
        .from("hotels")
        .select("total_rooms_per_type")
        .eq("id", hotelId)
        .maybeSingle();
      const defaultRooms =
        typeof hotelRow?.total_rooms_per_type === "number"
          ? hotelRow.total_rooms_per_type
          : 100;
      return parseCloudbedsRoomTypes(raw, defaultRooms);
    },

    async fetchReservationListPage(
      window: { from: string; to: string; newest?: boolean },
      cursor: AdapterCursor | null,
    ): Promise<{
      rows: AdapterReservationRow[];
      nextCursor: AdapterCursor | null;
      nextWindowCursor?: AdapterCursor | null;
    }> {
      const c = await credsWithProperty();
      const at = readCloudbedsHistoryCursor(cursor);

      if (at.kind === "list" && !at.legacy) return listPage(c, window, at.statusIndex, at.pageNumber);
      if (refusal !== null) {
        return at.kind === "list" ? listPage(c, window, at.statusIndex, at.pageNumber) : listPage(c, window, 0, 1);
      }

      const pageNumber = at.kind === "rate_details" ? at.pageNumber : 1;
      // A legacy cursor's window was part-read by check-in, like the one before it.
      const openEnd = window.newest === true || at.kind === "list" || at.openEnd;
      const historyWindow: CloudbedsHistoryWindow = { from: window.from, to: window.to, openEnd };
      let page: Awaited<ReturnType<typeof cloudbedsGetReservationsWithRateDetailsPage>>;
      try {
        page = await cloudbedsGetReservationsWithRateDetailsPage(c, cloudbedsHistoryQuery(historyWindow), pageNumber);
      } catch (error) {
        if (!cloudbedsRateDetailsRefused(error)) throw error;
        refusal = error.message.slice(0, 300);
        // The error text is Cloudbeds' own words about the account, never a booking.
        console.warn(
          JSON.stringify({
            fn: "cloudbedsHistoryImport",
            hotelId,
            warning: "getReservationsWithRateDetails refused; importing history from the getReservations list",
            status: error.status,
            refusal,
          }),
        );
        // A refusal after some rate-details pages were written restarts the
        // window on the list, by check-in. That overlaps what was written
        // (same keys, so upserted, not doubled) and leaves nothing out.
        return at.kind === "list" ? listPage(c, window, at.statusIndex, at.pageNumber) : listPage(c, window, 0, 1);
      }

      const { rows } = parseCloudbedsHistoryRateDetails(page.reservations, historyWindow);
      if (page.hasMore) {
        return { rows, nextCursor: openEnd ? { pageNumber: pageNumber + 1, openEnd: true } : { pageNumber: pageNumber + 1 } };
      }
      return { rows, nextCursor: null, nextWindowCursor: { after: "checkout" } };
    },
  };
}
