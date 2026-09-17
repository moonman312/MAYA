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
 *
 * Pages come newest booking first (dateCreated descending, the same order on
 * a second full read; sandbox, 2026-09-17), and pages here are minutes apart,
 * so a stored page number only means something while the result set holds
 * still. Three things keep it still: every status is read
 * (a cancellation changes a booking, it does not remove it), the booking
 * created bound is pinned for the whole window (a new booking cannot join),
 * and the set's total is carried on the cursor: if it moved anyway, the window
 * is read again from page 1.
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
  cloudbedsTimestamp,
  type CloudbedsRateDetailsQuery,
} from "./client.ts";
import {
  cloudbedsStayDates,
  parseCloudbedsHistoryRateDetails,
  parseCloudbedsReservations,
  parseCloudbedsRoomTypes,
  type CloudbedsHistoryWindow,
} from "./etl.ts";
import {
  CLOUDBEDS_ACTIVE_STATUSES,
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
 *   { pageNumber, createdTo, total, openEnd?, restarts? }
 *                                          rate details, the page to read next
 *   { path: "list", statusIndex, pageNumber, closed? }
 *                                          the list fallback, mid-window
 *   { statusIndex, pageNumber }            written by the list-only deploy
 *
 * The page number is the only position. The rest pins the question: `openEnd`
 * says which query this window pages through, `createdTo` the booking-created
 * bound it was first asked with, `total` how many bookings that query matched
 * on the last page read, and `restarts` how often the window was read again
 * because that total moved.
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
 * open-ended, and says so (restartWindow) so the worker stops counting what
 * the old pages wrote. Upserts are keyed (hotel_id, external_reservation_id,
 * stay_date), so those rows are overwritten in place with real rates, and the
 * nights the list path keyed under a room that is not theirs are deleted
 * (reconcileIds). If the property refuses rate details the legacy cursor
 * means exactly what it meant, and the list fallback resumes on that status
 * and page.
 */
type CloudbedsCursor =
  | {
      kind: "rate_details";
      pageNumber: number;
      openEnd: boolean;
      /** No page of this window has been read yet. */
      start: boolean;
      /** The window started from a handover by a window owned by check-out. */
      handedCheckout: boolean;
      createdTo: string | null;
      total: number | null;
      restarts: number;
    }
  | { kind: "list"; statusIndex: number; pageNumber: number; legacy: boolean; closed: boolean };

/** Times a window is read again from page 1 because its total moved, before it pages on regardless. */
export const CLOUDBEDS_HISTORY_MAX_RESTARTS = 3;

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

export function readCloudbedsHistoryCursor(cursor: AdapterCursor | null): CloudbedsCursor {
  if (cursor && typeof cursor.statusIndex === "number" && typeof cursor.pageNumber === "number") {
    const statusIndex = Math.max(0, Math.floor(cursor.statusIndex));
    const pageNumber = Math.max(1, Math.floor(cursor.pageNumber));
    if (cursor.path === "list") {
      return { kind: "list", statusIndex, pageNumber, legacy: false, closed: cursor.closed === true };
    }
    return { kind: "list", statusIndex, pageNumber, legacy: true, closed: false };
  }
  const pageNumber = cursor ? positiveInt(cursor.pageNumber) : null;
  if (cursor && pageNumber !== null) {
    return {
      kind: "rate_details",
      pageNumber,
      openEnd: cursor.openEnd === true,
      start: false,
      handedCheckout: false,
      createdTo: typeof cursor.createdTo === "string" && cursor.createdTo ? cursor.createdTo : null,
      total: typeof cursor.total === "number" && Number.isFinite(cursor.total) ? cursor.total : null,
      restarts: typeof cursor.restarts === "number" && cursor.restarts > 0 ? Math.floor(cursor.restarts) : 0,
    };
  }
  // Window start. Only a handover from a check-out-owned window closes it.
  const handedCheckout = cursor?.after === "checkout";
  return {
    kind: "rate_details",
    pageNumber: 1,
    openEnd: !handedCheckout,
    start: true,
    handedCheckout,
    createdTo: null,
    total: null,
    restarts: 0,
  };
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * The booking-created bound a window is pinned to, taken when its first page
 * is read: a day before now. The day covers whatever time zone Cloudbeds reads
 * the timestamp in, so the bound is in the past however it is read, and no
 * booking made while the window pages can join it, and since pages are newest
 * first, one that did would push every later booking down a place. The
 * sandbox takes this `YYYY-MM-DD HH:MM:SS` form and cuts on it exactly
 * (2026-09-17). What it gives up is a
 * booking entered in the last day for a stay the window owns, which checked
 * in at least 31 days ago: a stay keyed in a month late.
 */
export function cloudbedsHistoryCreatedTo(nowMs: number): string {
  return cloudbedsTimestamp(new Date(nowMs - 24 * 60 * 60 * 1000));
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
 *
 * No status is left out server-side. excludeStatuses would make a booking
 * canceled between two page reads drop out of the set and pull every later
 * booking up a place, so one would fall between pages unread; reading them
 * also lets a window delete the nights of a booking canceled since an earlier
 * import stored it. parseCloudbedsHistoryRateDetails keeps only active ones.
 */
export function cloudbedsHistoryQuery(
  window: CloudbedsHistoryWindow,
  createdTo?: string,
): CloudbedsRateDetailsQuery {
  return {
    checkOutFrom: addDaysYmd(window.from, -1),
    checkOutTo: window.openEnd ? undefined : addDaysYmd(window.to, 1),
    createdTo,
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

  type PageResult = Awaited<ReturnType<OnboardingPmsAdapter["fetchReservationListPage"]>>;

  /**
   * The list fallback: one page of getReservations for one status, filtered
   * by check-in over the window as the import always did. Nightly rate is the
   * booking total over (rooms x nights), and a multi-room booking whose list
   * row names no rooms is counted as one room. Kept only for accounts that
   * refuse rate details.
   *
   * `closed` is set when the newer window was owned by check-out. That window
   * already stored every booking checking in here and out after `to`, from
   * rate details, so the list leaves those alone: its one-room keys would land
   * on another room's rows.
   */
  async function listPage(
    c: CloudbedsResolvedCredentials,
    window: { from: string; to: string },
    statusIndex: number,
    pageNumber: number,
    closed: boolean,
  ): Promise<PageResult> {
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

    const mine = closed
      ? reservations.filter((r) => {
          const { checkOut } = cloudbedsStayDates(r);
          return checkOut === null || checkOut <= window.to;
        })
      : reservations;

    // Slim rows keyed the same way the detail sync keys its rows,
    // raw_payload dropped entirely.
    const parsed = parseCloudbedsReservations(mine);
    const rows: AdapterReservationRow[] = parsed.reservations.map((r) => ({
      external_reservation_id: r.external_reservation_id,
      external_room_type_id: r.external_room_type_id,
      stay_date: r.stay_date,
      booking_date: r.booking_date,
      booking_window_days: r.booking_window_days,
      current_rate: r.current_rate,
      raw_payload: null,
    }));

    const at = (i: number, n: number): AdapterCursor =>
      closed ? { path: "list", statusIndex: i, pageNumber: n, closed: true } : { path: "list", statusIndex: i, pageNumber: n };
    const nextCursor: AdapterCursor | null = hasMore
      ? at(statusIndex, pageNumber + 1)
      : statusIndex + 1 < CLOUDBEDS_ACTIVE_STATUSES.length
        ? at(statusIndex + 1, 1)
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
    ): Promise<PageResult> {
      const c = await credsWithProperty();
      const at = readCloudbedsHistoryCursor(cursor);

      if (at.kind === "list" && !at.legacy) return listPage(c, window, at.statusIndex, at.pageNumber, at.closed);

      // The list may only take over where rate details has written nothing
      // for this window: at its start, or on a cursor the list-only deploy
      // left. Past that, the list would re-read by check-in bookings this
      // window already stored per room, and its one-room keys would land on
      // another room's rows.
      const mayFallBack = at.kind === "list" || at.start;
      const fallBack = () =>
        at.kind === "list"
          ? listPage(c, window, at.statusIndex, at.pageNumber, false)
          : listPage(c, window, 0, 1, at.handedCheckout);
      if (refusal !== null && mayFallBack) return fallBack();

      const pageNumber = at.kind === "rate_details" ? at.pageNumber : 1;
      // A legacy cursor's window was part-read by check-in, like the one before it.
      const openEnd = window.newest === true || at.kind === "list" || at.openEnd;
      const historyWindow: CloudbedsHistoryWindow = { from: window.from, to: window.to, openEnd };
      const createdTo = (at.kind === "rate_details" ? at.createdTo : null) ?? cloudbedsHistoryCreatedTo(Date.now());
      const restarts = at.kind === "rate_details" ? at.restarts : 0;

      let page: Awaited<ReturnType<typeof cloudbedsGetReservationsWithRateDetailsPage>>;
      try {
        page = await cloudbedsGetReservationsWithRateDetailsPage(
          c,
          cloudbedsHistoryQuery(historyWindow, createdTo),
          pageNumber,
        );
      } catch (error) {
        // Refused after rate details already served this window: that says
        // nothing about the account (any 4xx counts as a refusal, and a
        // success:false body is a 400), so the step fails and retries on
        // this same page.
        if (!cloudbedsRateDetailsRefused(error) || !mayFallBack) throw error;
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
        return fallBack();
      }

      const nextPageCursor = (n: number, fields: { total: number | null; restarts: number }): AdapterCursor => ({
        pageNumber: n,
        ...(openEnd ? { openEnd: true } : {}),
        createdTo,
        ...(fields.total !== null ? { total: fields.total } : {}),
        ...(fields.restarts > 0 ? { restarts: fields.restarts } : {}),
      });

      // The set moved under the pages already read, so this page number no
      // longer points where it did. Read the window again; upserts make that
      // safe, and restartWindow keeps the worker from counting it twice.
      const priorTotal = at.kind === "rate_details" ? at.total : null;
      if (
        priorTotal !== null &&
        page.total !== null &&
        page.total !== priorTotal &&
        restarts < CLOUDBEDS_HISTORY_MAX_RESTARTS
      ) {
        console.warn(
          JSON.stringify({
            fn: "cloudbedsHistoryImport",
            hotelId,
            warning: "history window changed while paging; reading it again from page 1",
            windowFrom: window.from,
            windowTo: window.to,
            pageNumber,
            totalWas: priorTotal,
            totalNow: page.total,
          }),
        );
        return {
          rows: [],
          nextCursor: nextPageCursor(1, { total: null, restarts: restarts + 1 }),
          restartWindow: true,
        };
      }

      const { rows, reconcileIds } = parseCloudbedsHistoryRateDetails(page.reservations, historyWindow);
      const restartWindow = at.kind === "list";
      const nextCursor = page.hasMore ? nextPageCursor(pageNumber + 1, { total: page.total, restarts }) : null;
      return {
        rows,
        reconcileIds,
        ...(restartWindow ? { restartWindow } : {}),
        nextCursor,
        ...(nextCursor ? {} : { nextWindowCursor: { after: "checkout" } }),
      };
    },
  };
}
