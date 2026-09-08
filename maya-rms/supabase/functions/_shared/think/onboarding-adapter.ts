/**
 * Think implementation of OnboardingPmsAdapter.
 *
 * Simpler than the Cloudbeds one because Think's reservations endpoint is
 * already complete: one paged listing carries bookings, statuses and line
 * items, so there is no slim-vs-detail split and no per-status cursor walk —
 * the cursor is just the page number. Historical rows still store
 * raw_payload null: onboarding history only feeds demand analysis, and the
 * strongest PII stance for old stays is not storing the payload at all.
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
  buildReservationRangeParams,
  thinkGetHotels,
  thinkGetReservationsPage,
  thinkGetRoomTypes,
  type ThinkHotel,
} from "./client.ts";
import { parseThinkReservations, parseThinkRoomTypes } from "./etl.ts";
import { THINK_API_BASE_URL, THINK_PAGE_SIZE } from "./constants.ts";
import type { ThinkCredentials } from "./types.ts";

function asPage(cursor: AdapterCursor | null): number {
  return cursor && typeof cursor.page === "number" && cursor.page >= 0 ? cursor.page : 0;
}

export async function createThinkOnboardingAdapter(
  supabase: SupabaseClient,
  hotelId: string,
  preResolved?: PreResolvedOAuthCredentials,
): Promise<OnboardingPmsAdapter> {
  // pms_connections.base_url wins over the env default (same as sync-hotel).
  const { data: connRow } = await supabase
    .from("pms_connections")
    .select("base_url")
    .eq("hotel_id", hotelId)
    .eq("pms_type", "think")
    .maybeSingle();
  const baseUrl = ((connRow?.base_url as string | null) || THINK_API_BASE_URL).replace(
    /\/$/,
    "",
  );

  let knownPropertyId = preResolved?.propertyId ?? null;
  // The /v1/hotels answer, kept for the run: it names the property AND its
  // time zone, which the reservation parse needs before any hotels row
  // exists to read one from.
  let discovered: ThinkHotel | null = null;

  async function creds(): Promise<ThinkCredentials> {
    if (preResolved) {
      return { accessToken: preResolved.accessToken, baseUrl };
    }
    const resolved = await resolveOAuthCredentials(supabase, hotelId, "think");
    if ("error" in resolved) {
      throw new Error(`Think credentials unavailable: ${resolved.error}`);
    }
    if (!knownPropertyId && resolved.propertyId) knownPropertyId = resolved.propertyId;
    return { accessToken: resolved.accessToken, baseUrl };
  }

  async function discover(): Promise<ThinkHotel> {
    if (discovered) return discovered;
    const c = await creds();
    const hotels = await thinkGetHotels(c);
    const match = knownPropertyId
      ? hotels.find((h) => h.externalId === knownPropertyId)
      : hotels.length === 1
        ? hotels[0]
        : undefined;
    if (!match) {
      throw new Error(
        hotels.length === 0
          ? "Think: this token can read no hotels."
          : "Think: token reads multiple hotels and none matches the stored externalId.",
      );
    }
    if (!knownPropertyId) {
      knownPropertyId = match.externalId;
      await persistPropertyId(supabase, hotelId, "think", match.externalId).catch(() => {
        // Non-fatal: discovery just repeats next run.
      });
      if (preResolved) preResolved.propertyId = match.externalId;
    }
    discovered = match;
    return match;
  }

  return {
    pmsType: "think",
    capabilities: { historicalImport: true, needsDetailFetch: false },

    async discoverProperty(): Promise<PmsPropertyProfile> {
      const hotel = await discover();
      return {
        externalPropertyId: hotel.externalId,
        name: hotel.name || null,
        timezone: hotel.timeZone,
        currency: hotel.currencyCode,
      };
    },

    async fetchRoomTypes(): Promise<AdapterRoomType[]> {
      const c = await creds();
      const hotel = await discover();
      const raw = await thinkGetRoomTypes(c, hotel.externalId);
      const { data: hotelRow } = await supabase
        .from("hotels")
        .select("total_rooms_per_type")
        .eq("id", hotelId)
        .maybeSingle();
      const defaultRooms =
        typeof hotelRow?.total_rooms_per_type === "number"
          ? hotelRow.total_rooms_per_type
          : 100;
      return parseThinkRoomTypes(raw, defaultRooms);
    },

    async fetchReservationListPage(
      window: { from: string; to: string },
      cursor: AdapterCursor | null,
    ): Promise<{ rows: AdapterReservationRow[]; nextCursor: AdapterCursor | null }> {
      const c = await creds();
      const hotel = await discover();
      const page = asPage(cursor);

      const pageRes = await thinkGetReservationsPage(
        c,
        hotel.externalId,
        buildReservationRangeParams({ stayFrom: window.from, stayTo: window.to }),
        page,
        THINK_PAGE_SIZE,
      );

      const parsed = parseThinkReservations(pageRes.content, {
        hotelTimeZone: hotel.timeZone ?? "UTC",
      });
      const rows: AdapterReservationRow[] = parsed.rows.map((r) => ({
        external_reservation_id: r.external_reservation_id,
        external_room_type_id: r.external_room_type_id,
        stay_date: r.stay_date,
        booking_date: r.booking_date,
        booking_window_days: r.booking_window_days,
        current_rate: r.current_rate,
        raw_payload: null,
      }));

      return { rows, nextCursor: pageRes.last ? null : { page: page + 1 } };
    },
  };
}
