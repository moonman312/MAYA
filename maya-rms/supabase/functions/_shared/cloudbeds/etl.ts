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

/** Keys that name a room on a reservation or room entry. */
const ROOM_ID_KEYS = ["subReservationID", "reservationRoomID", "roomID"];
/** `id` is not read off a room entry: there it is as likely the room's own id. */
const ROOM_TYPE_KEYS = ["roomTypeID", "roomTypeId"];

/**
 * Extract the booking-level room-type id. Classic reservations can carry a
 * top-level roomTypeID or a rooms[]/assigned[] array. ⚠ VERIFY for your data.
 */
function reservationRoomTypeId(res: Json): string | null {
  const top = firstString(res, ROOM_TYPE_KEYS);
  if (top) return top;
  for (const key of ["assigned", "rooms", "roomStays"]) {
    const arr = res[key];
    if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === "object") {
      const rt = firstString(arr[0] as Json, ROOM_TYPE_KEYS);
      if (rt) return rt;
    }
  }
  return null;
}

/**
 * A garbage room count must not be able to fabricate a page of room-nights —
 * `roomsQuantity: "50000"` over 3 nights is 150k rows from one booking, and the
 * import worker's row cap is only checked after the page is written. Clipping a
 * genuine 65-room buyout is the safer direction: an undercount stays an
 * undercount, while fabricated rows are permanent phantom occupancy.
 */
const MAX_DECLARED_ROOM_SLOTS = 64;

/**
 * The physical rooms one booking covers — one slot per room, `null` where the
 * payload only declares a count. Both import paths size bookings with this, so
 * neither can disagree with the other about how many rooms a booking has.
 *
 * `assigned[]` is the detail payload's verified shape: one entry per physical
 * room, each with its own dailyRates. `rooms[]` is a list-payload guess, trusted
 * only as far as the distinct room ids it names. `roomStays[]` is deliberately
 * not counted at all — it is one entry per stay SEGMENT, so a room change
 * mid-stay is two entries for one room, and counting those as rooms doubles
 * occupancy while halving ADR.
 * ⚠ VERIFY the declared-count keys against your account.
 */
export function cloudbedsRoomSlots(res: Json): (Json | null)[] {
  if (Array.isArray(res.assigned)) {
    const entries = res.assigned.filter((e): e is Json => !!e && typeof e === "object");
    if (entries.length > 0) return entries;
  }
  if (Array.isArray(res.rooms)) {
    const byRoomId = new Map<string, Json>();
    for (const e of res.rooms) {
      if (!e || typeof e !== "object") continue;
      const id = firstString(e as Json, ROOM_ID_KEYS);
      if (id && !byRoomId.has(id)) byRoomId.set(id, e as Json);
    }
    if (byRoomId.size > 0) return [...byRoomId.values()];
  }
  const declared = firstNumber(res, ["roomsQuantity", "roomCount", "numRooms", "roomsCount"]);
  const count =
    declared != null && declared >= 1
      ? Math.min(Math.floor(declared), MAX_DECLARED_ROOM_SLOTS)
      : 1;
  return new Array(count).fill(null);
}

/**
 * Row ids for a booking's room slots, all inside the `<reservationID>-<n>`
 * namespace. Every path that writes or deletes room-night rows keys them with
 * this, and they have to agree: the unique key is
 * (hotel_id, external_reservation_id, stay_date), so a room-night the list path
 * keyed one way and the detail path another is stored twice instead of upserted,
 * and a cancellation looking for one key leaves the other behind.
 *
 * An explicit id is only honoured when it is prefixed with the parent
 * reservation id. `roomID` is the id of a PHYSICAL room, reused by every booking
 * that ever occupies it — keying on it would merge two different stays in room
 * 101 onto one row and let cancelling either one delete the other's nights.
 * A `subReservationID` is namespaced to its booking, but nothing in a payload
 * distinguishes one from a bare `roomID` except that prefix.
 * ⚠ VERIFY the `<reservationID>-<n>` shape against a live account: the only
 * evidence for it here is one payload fixture (src/lib/pms/redact.test.ts).
 */
export function cloudbedsRoomRowIds(parentId: string, slots: (Json | null)[]): string[] {
  const explicit = slots.map((entry) => {
    const id = entry ? firstString(entry, ROOM_ID_KEYS) : null;
    return id && id.startsWith(`${parentId}-`) ? id : null;
  });
  const taken = new Set(explicit.filter((id): id is string => id !== null));
  let n = 1;
  return explicit.map((id) => {
    if (id) return id;
    // A payload can spell out `-2` and leave `-1` anonymous; skip what's taken.
    while (taken.has(`${parentId}-${n}`)) n += 1;
    const derived = `${parentId}-${n}`;
    taken.add(derived);
    return derived;
  });
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
 * Parse a list of reservation objects into per-room, per-night reservation rows
 * — the same grain and the same row keys as the detail parse below.
 *
 * `nightlyRateByResId` (optional) maps a booking's PARENT id to its nightly
 * rates, so it is one rate per booking-night applied to each of that booking's
 * rooms, not a per-room rate. Absent → nightly rate = total / (rooms × nights),
 * because a Cloudbeds `total` covers the whole booking, every room and night.
 *
 * KNOWN UNDERCOUNT, unfixable from a list payload: most accounts' list rows name
 * neither rooms nor a room count (see the fetch comment in sync-hotel.ts), and
 * such a booking is recorded as ONE room at the whole-booking nightly rate — for
 * an N-room group, occupancy 1/N of the truth and ADR N× it. Nothing repairs it
 * afterwards: the onboarding historical windows are the only pass that ever
 * reads stays older than the live sync's own check-in window. The fix is a
 * payload that carries the rooms (Cloudbeds' getReservationsWithRateDetails is
 * page-level, so it costs one call per page, not per reservation), not a
 * guess — fabricating slots we cannot identify double-counts instead.
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

    const bookingRoomTypeId = reservationRoomTypeId(res);
    const bookingDate = toYmd(firstString(res, ["dateCreated", "created", "bookingDate"]) ?? "");

    const slots = cloudbedsRoomSlots(res);
    const roomIds = cloudbedsRoomRowIds(rid, slots);
    const detailRates = nightlyRateByResId?.get(rid) ?? null;
    const total =
      firstNumber(res, ["total", "balance", "grandTotal", "totalRate", "roomTotal"]) ?? null;
    const fallbackNightly =
      total != null ? Math.round((total / (nights.length * slots.length)) * 100) / 100 : null;

    for (let slot = 0; slot < slots.length; slot += 1) {
      const entry = slots[slot];
      const roomId = roomIds[slot];
      const externalRoomTypeId =
        (entry ? firstString(entry, ROOM_TYPE_KEYS) : null) ?? bookingRoomTypeId;

      for (const night of nights) {
        const nightly =
          (detailRates && Number.isFinite(detailRates[night])
            ? detailRates[night]
            : fallbackNightly) ?? null;
        const key = `${roomId}:${night}`;
        if (byStayNight.has(key)) stats.duplicateStayNightKeysMerged += 1;
        byStayNight.set(key, {
          external_reservation_id: roomId,
          external_room_type_id: externalRoomTypeId,
          stay_date: night,
          booking_date: bookingDate,
          booking_window_days: bookingDate ? bookingWindowFor(bookingDate, night) : null,
          current_rate: nightly,
          raw_payload: redactCloudbedsPayload(res),
        });
      }
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
 * room-night per (assigned room, date) so occupancy counts and nightly rates are
 * correct, keyed by cloudbedsRoomRowIds so each physical room is tracked
 * independently and the list path lands on these same rows.
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
  // Without a parent id there is no namespace to key rooms in, and a row keyed by
  // a bare roomID belongs to the room rather than to this booking.
  const slots = reservationId ? cloudbedsRoomSlots(detail) : [];
  const roomIds = reservationId ? cloudbedsRoomRowIds(reservationId, slots) : [];

  for (let slot = 0; slot < slots.length; slot += 1) {
    const room = slots[slot];
    if (!room) continue;
    const rtId = firstString(room, ROOM_TYPE_KEYS);
    const subId = roomIds[slot];

    const daily = Array.isArray(room.dailyRates) ? (room.dailyRates as Json[]) : [];
    for (const dr of daily) {
      if (!dr || typeof dr !== "object") continue;
      const d = dr as Json;
      const stay = toYmd(firstString(d, ["date", "day", "stayDate"]) ?? "");
      if (!stay) continue;
      const rate = firstNumber(d, ["rate", "amount", "roomRate", "price"]);

      rows.push({
        external_reservation_id: subId,
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
