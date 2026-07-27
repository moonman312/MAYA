/**
 * Cloudbeds implementation of OnboardingPmsAdapter.
 *
 * Wraps the existing classic-API client. The slim list pull walks
 * getReservations one page at a time (one status per cursor step) so the
 * import worker can checkpoint between pages — a killed run resumes at the
 * exact page it stopped on.
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
import {
  cloudbedsDiscoverPropertyId,
  cloudbedsGetHotelDetails,
  cloudbedsGetReservationsPage,
  cloudbedsGetRoomTypes,
} from "./client.ts";
import { parseCloudbedsReservations, parseCloudbedsRoomTypes } from "./etl.ts";
import { CLOUDBEDS_ACTIVE_STATUSES, defaultCloudbedsBaseUrl } from "./constants.ts";
import type { CloudbedsResolvedCredentials } from "./types.ts";

type CloudbedsCursor = { statusIndex: number; pageNumber: number };

function asCursor(cursor: AdapterCursor | null): CloudbedsCursor {
  if (
    cursor &&
    typeof cursor.statusIndex === "number" &&
    typeof cursor.pageNumber === "number"
  ) {
    return { statusIndex: cursor.statusIndex, pageNumber: cursor.pageNumber };
  }
  return { statusIndex: 0, pageNumber: 1 };
}

export async function createCloudbedsOnboardingAdapter(
  supabase: SupabaseClient,
  hotelId: string,
  preResolved?: PreResolvedOAuthCredentials,
): Promise<OnboardingPmsAdapter> {
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
      throw new Error("Cloudbeds: could not discover propertyID for this account.");
    }
    await persistPropertyId(supabase, hotelId, "cloudbeds", discovered).catch(() => {
      // Non-fatal: discovery just repeats next run.
    });
    if (preResolved) preResolved.propertyId = discovered;
    return { ...c, propertyId: discovered };
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
      window: { from: string; to: string },
      cursor: AdapterCursor | null,
    ): Promise<{ rows: AdapterReservationRow[]; nextCursor: AdapterCursor | null }> {
      const c = await credsWithProperty();
      const { statusIndex, pageNumber } = asCursor(cursor);

      if (statusIndex >= CLOUDBEDS_ACTIVE_STATUSES.length) {
        return { rows: [], nextCursor: null };
      }

      const status = CLOUDBEDS_ACTIVE_STATUSES[statusIndex];
      const { reservations, hasMore } = await cloudbedsGetReservationsPage(
        c,
        window.from,
        window.to,
        status,
        pageNumber,
      );

      // Slim rows: nightly rate = total / nights, raw_payload dropped entirely.
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
        ? { statusIndex, pageNumber: pageNumber + 1 }
        : statusIndex + 1 < CLOUDBEDS_ACTIVE_STATUSES.length
          ? { statusIndex: statusIndex + 1, pageNumber: 1 }
          : null;

      return { rows, nextCursor };
    },
  };
}
