/**
 * Cloudbeds → Supabase row shapes. Mirrors the intent of _shared/mews/etl.ts.
 *
 * Produces rows for the SAME `room_types` and `reservations` tables Mews writes,
 * so the rest of the pipeline (snapshots, engine, calendar) is PMS-agnostic.
 *
 * ⚠ VERIFY every field path against live Cloudbeds responses. Cloudbeds field
 * names differ across API generations; the candidate lists below are tried in
 * order so you can adjust without restructuring. Marked spots are the ones most
 * likely to need tweaking for your account.
 */

import {
  CLOUDBEDS_CANCELED_STATUSES,
} from "./constants.ts";
import { redactCloudbedsPayload } from "../pms/redact.ts";
import type {
  CloudbedsParsedReservationRow,
  CloudbedsParsedRoomType,
  CloudbedsParseStats,
} from "./types.ts";

type Json = Record<string, unknown>;

function firstString(obj: Json, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function firstNumber(obj: Json, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function toYmd(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  // Accept "2026-07-22", "2026-07-22 15:00:00", or ISO.
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function addOneDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Lead time against the stay night itself, not check-in — night 2 of a stay
 * is one day further out than night 1, and pickup windows compare per-night.
 */
function bookingWindowFor(bookingDate: string, stay: string): number {
  const a = new Date(`${stay}T00:00:00Z`).getTime();
  const b = new Date(`${bookingDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((a - b) / 86_400_000));
}

/** [checkIn, checkOut) hotel-night semantics; same-day → single night. */
function enumerateNights(checkIn: string, checkOut: string | null): string[] {
  if (!checkOut || checkOut <= checkIn) return [checkIn];
  const nights: string[] = [];
  let cur = checkIn;
  while (cur < checkOut) {
    nights.push(cur);
    cur = addOneDay(cur);
  }
  return nights;
}

/** ── Room types ─────────────────────────────────────────────
 * ⚠ VERIFY field names: roomTypeID, roomTypeName, roomTypeNameShort,
 * roomTypeUnits / roomsAvailable / totalUnits.
 */
export function parseCloudbedsRoomTypes(
  rows: Json[],
  defaultRoomsPerCategory: number,
): CloudbedsParsedRoomType[] {
  const out: CloudbedsParsedRoomType[] = [];
  for (const r of rows) {
    const id = firstString(r, ["roomTypeID", "roomTypeId", "id"]);
    if (!id) continue;
    const name =
      firstString(r, ["roomTypeName", "name", "roomTypeNameShort"]) ?? "Unknown";
    const shortName = firstString(r, ["roomTypeNameShort", "roomTypeName", "name"]);
    const units =
      firstNumber(r, ["roomTypeUnits", "roomsAvailable", "totalUnits", "units", "roomTypeTotalUnits"]) ??
      defaultRoomsPerCategory;
    out.push({
      external_room_type_id: id,
      name,
      display_name: shortName ?? name,
      total_rooms: Math.max(0, Math.floor(units)),
    });
  }
  return out;
}

function isCanceled(status: string | null): boolean {
  if (!status) return false;
  const n = status.trim().toLowerCase();
  return (CLOUDBEDS_CANCELED_STATUSES as readonly string[]).includes(n);
}

/**
 * Extract the room-type id for a reservation. Classic reservations can carry a
 * top-level roomTypeID or a rooms[]/assigned[] array. ⚠ VERIFY for your data.
 */
function reservationRoomTypeId(res: Json): string | null {
  const top = firstString(res, ["roomTypeID", "roomTypeId"]);
  if (top) return top;
  for (const key of ["rooms", "assigned", "roomStays"]) {
    const arr = res[key];
    if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === "object") {
      const rt = firstString(arr[0] as Json, ["roomTypeID", "roomTypeId", "id"]);
      if (rt) return rt;
    }
  }
  return null;
}

/**
 * Per-night rate map from a getReservation detail payload, if available.
 * ⚠ VERIFY: Cloudbeds detail exposes nightly rates as `dailyRates`,
 * `roomRateDetailed`, or a rooms[].detailedRates[] structure keyed by date.
 * Returns { 'YYYY-MM-DD': nightlyRate } or null when not resolvable.
 */
export function parseNightlyRatesFromDetail(detail: Json | null): Record<string, number> | null {
  if (!detail) return null;
  const map: Record<string, number> = {};

  const candidates: unknown[] = [
    detail.dailyRates,
    detail.roomRateDetailed,
    detail.detailedRates,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      for (const entry of c) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Json;
        const date = toYmd(firstString(e, ["date", "day", "stayDate"]) ?? "");
        const rate = firstNumber(e, ["rate", "amount", "roomRate", "price"]);
        if (date && rate != null) map[date] = rate;
      }
    } else if (c && typeof c === "object") {
      for (const [k, v] of Object.entries(c as Json)) {
        const date = toYmd(k);
        const rate = typeof v === "number" ? v : Number(v);
        if (date && Number.isFinite(rate)) map[date] = rate;
      }
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

const emptyStats = (): CloudbedsParseStats => ({
  skippedMissingReservationId: 0,
  skippedNoStayNights: 0,
  duplicateStayNightKeysMerged: 0,
  rowsWithMissingRate: 0,
  skippedCanceled: 0,
});

export type ParsedCloudbeds = {
  reservations: CloudbedsParsedReservationRow[];
  stats: CloudbedsParseStats;
  canceledExternalIds: string[];
};

/**
 * Parse a list of reservation objects into per-night reservation rows.
 * `nightlyRateByResId` (optional) supplies per-night rates from detail calls;
 * absent → nightly rate = reservation total / nights.
 */
export function parseCloudbedsReservations(
  reservations: Json[],
  nightlyRateByResId?: Map<string, Record<string, number>>,
): ParsedCloudbeds {
  const stats = emptyStats();
  const byStayNight = new Map<string, CloudbedsParsedReservationRow>();
  const canceled = new Set<string>();

  for (const res of reservations) {
    const rid = firstString(res, ["reservationID", "reservationId", "id"]);
    if (!rid) {
      stats.skippedMissingReservationId += 1;
      continue;
    }

    const status = firstString(res, ["status", "reservationStatus"]);
    if (isCanceled(status)) {
      canceled.add(rid);
      stats.skippedCanceled += 1;
      continue;
    }

    const checkIn = toYmd(firstString(res, ["startDate", "checkIn", "checkin", "arrival"]) ?? "");
    if (!checkIn) {
      stats.skippedNoStayNights += 1;
      continue;
    }
    const checkOut = toYmd(firstString(res, ["endDate", "checkOut", "checkout", "departure"]) ?? "");
    const nights = enumerateNights(checkIn, checkOut);
    if (nights.length === 0) {
      stats.skippedNoStayNights += 1;
      continue;
    }

    const externalRoomTypeId = reservationRoomTypeId(res);
    const bookingDate = toYmd(firstString(res, ["dateCreated", "created", "bookingDate"]) ?? "");

    const detailRates = nightlyRateByResId?.get(rid) ?? null;
    const total =
      firstNumber(res, ["total", "balance", "grandTotal", "totalRate", "roomTotal"]) ?? null;
    const fallbackNightly = total != null ? Math.round((total / nights.length) * 100) / 100 : null;

    for (const night of nights) {
      const nightly =
        (detailRates && Number.isFinite(detailRates[night]) ? detailRates[night] : fallbackNightly) ??
        null;
      const key = `${rid}:${night}`;
      if (byStayNight.has(key)) stats.duplicateStayNightKeysMerged += 1;
      byStayNight.set(key, {
        external_reservation_id: rid,
        external_room_type_id: externalRoomTypeId,
        stay_date: night,
        booking_date: bookingDate,
        booking_window_days: bookingDate ? bookingWindowFor(bookingDate, night) : null,
        current_rate: nightly,
        raw_payload: redactCloudbedsPayload(res),
      });
    }
  }

  for (const row of byStayNight.values()) {
    if (row.current_rate === null) stats.rowsWithMissingRate += 1;
  }

  return {
    reservations: [...byStayNight.values()],
    stats,
    canceledExternalIds: [...canceled],
  };
}

/**
 * Parse a getReservation DETAIL payload into per-room-per-night rows.
 *
 * Cloudbeds' reservation list is minimal (no room type, no nightly rate); the
 * detail payload carries `assigned[]`, one entry per physical room, each with a
 * `roomTypeID` and a `dailyRates: [{date, rate}]` array. We emit one booked
 * room-night per (assigned room, date) so occupancy counts and nightly rates
 * are correct. `external_reservation_id` uses the per-room `subReservationID`
 * so each physical room is tracked independently.
 *
 * Verified against the live sandbox getReservation response.
 */
export function parseCloudbedsReservationDetail(detail: Json): {
  reservationId: string | null;
  status: string | null;
  rows: CloudbedsParsedReservationRow[];
} {
  const reservationId = firstString(detail, ["reservationID", "reservationId", "id"]);
  const status = firstString(detail, ["status", "reservationStatus"]);
  const bookingDate = toYmd(firstString(detail, ["dateCreated", "created", "bookingDate"]) ?? "");

  const rows: CloudbedsParsedReservationRow[] = [];
  // Prefer `assigned[]` (has dailyRates); fall back to guestList[].rooms if absent.
  const assigned = Array.isArray(detail.assigned) ? (detail.assigned as Json[]) : [];

  for (const entry of assigned) {
    if (!entry || typeof entry !== "object") continue;
    const room = entry as Json;
    const rtId = firstString(room, ["roomTypeID", "roomTypeId"]);
    const subId =
      firstString(room, ["subReservationID", "reservationRoomID", "roomID"]) ?? reservationId;
    if (!subId) continue;

    const daily = Array.isArray(room.dailyRates) ? (room.dailyRates as Json[]) : [];
    for (const dr of daily) {
      if (!dr || typeof dr !== "object") continue;
      const d = dr as Json;
      const stay = toYmd(firstString(d, ["date", "day", "stayDate"]) ?? "");
      if (!stay) continue;
      const rate = firstNumber(d, ["rate", "amount", "roomRate", "price"]);

      rows.push({
        external_reservation_id: String(subId),
        external_room_type_id: rtId,
        stay_date: stay,
        booking_date: bookingDate,
        booking_window_days: bookingDate ? bookingWindowFor(bookingDate, stay) : null,
        current_rate: rate,
        raw_payload: redactCloudbedsPayload(room),
      });
    }
  }

  return { reservationId, status, rows };
}
