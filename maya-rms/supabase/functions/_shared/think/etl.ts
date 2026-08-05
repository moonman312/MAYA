/**
 * ThinkReservations → Supabase row shapes. Mirrors the intent of
 * _shared/mews/etl.ts and _shared/cloudbeds/etl.ts.
 *
 * Produces rows for the SAME `room_types` and `reservations` tables the other
 * integrations write, so the rest of the pipeline (snapshots, engine,
 * calendar) is PMS-agnostic.
 *
 * Field shapes follow Think's OpenAPI spec: a Reservation carries bookings[]
 * (one per room stay, with civil startDate/endDate) plus lineItems[] (charges
 * discriminated by billingType, each billed at an instant). The grain here is
 * per booking per night, like the Cloudbeds parse, so a two-room reservation
 * counts as two rooms of occupancy rather than one.
 */

import { addCalendarDays } from "../engine/timezone.ts";

type Json = Record<string, unknown>;

function asJson(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const ZONE_QUALIFIED = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LEADING_YMD = /^(\d{4}-\d{2}-\d{2})/;
const YMD_PARTS = { year: "numeric", month: "2-digit", day: "2-digit" } as const;

const formatterByTimeZone = new Map<string, Intl.DateTimeFormat>();

/**
 * One formatter per zone: a sync parses thousands of reservations in one
 * invocation and building these per row costs more than the rest of the parse
 * put together. A junk `hotels.timezone` makes Intl throw, which would fail
 * the whole hotel instead of one row, so it degrades to UTC.
 */
function hotelDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterByTimeZone.get(timeZone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, ...YMD_PARTS });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...YMD_PARTS });
  }
  formatterByTimeZone.set(timeZone, fmt);
  return fmt;
}

/**
 * Think's timestamps (`createdAt`, `billingDate`) are instants — the spec
 * examples carry a Z — while bookings hold civil dates. An evening event at a
 * hotel west of Greenwich lands after midnight UTC, so truncating the instant
 * would date a booking a day late (shortening every lead time on the stay) and
 * drop a night's room charge onto the wrong night. A zone-less string is read
 * as a civil day instead: parsing it with `new Date` would apply the machine's
 * zone, not the hotel's.
 */
function instantToHotelDate(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!ZONE_QUALIFIED.test(s)) return LEADING_YMD.exec(s)?.[1] ?? null;
  const d = new Date(s.replace(/Z$/, "+00:00"));
  if (Number.isNaN(d.getTime())) return null;
  if (timeZone === "UTC") return d.toISOString().slice(0, 10);
  return hotelDateFormatter(timeZone).format(d);
}

/**
 * [startDate, endDate) hotel-night semantics; same-day → single night.
 * Booking dates are `format: date` in the spec — already civil days on the
 * hotel's own calendar, so running them through a timezone here would be the
 * bug, not the fix (see the ArrivalDate note in mews/etl.ts).
 */
function enumerateNights(startDate: string, endDate: string | null): string[] {
  if (!endDate || endDate <= startDate) return [startDate];
  const nights: string[] = [];
  let cur = startDate;
  while (cur < endDate) {
    nights.push(cur);
    cur = addCalendarDays(cur, 1);
  }
  return nights;
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

export type ThinkParsedRoomType = {
  external_room_type_id: string;
  name: string;
  display_name: string;
  total_rooms: number;
};

/** ── Room types ─────────────────────────────────────────────
 * The spec's RoomType is just { id, name } — no inventory count anywhere on
 * it; the physical rooms live behind the separate /rooms endpoint. Until the
 * sync counts real rooms from there, every category gets the hotel default so
 * occupancy math has a denominator, and a later count can overwrite it
 * without reshaping anything.
 */
export function parseThinkRoomTypes(
  raw: unknown[],
  defaultRooms: number,
): ThinkParsedRoomType[] {
  const out: ThinkParsedRoomType[] = [];
  for (const entry of raw) {
    const rt = asJson(entry);
    if (!rt) continue;
    const id = str(rt.id);
    if (!id) continue;
    const name = str(rt.name) ?? "Unknown";
    out.push({
      external_room_type_id: id,
      name,
      display_name: name,
      total_rooms: Math.max(0, Math.floor(defaultRooms)),
    });
  }
  return out;
}

/** Both spellings survive here even though the spec enum only has one — the
 * enum is the server's promise, and a promise is cheaper to hedge than a
 * phantom booked night is to find. */
function isCanceledThinkStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const n = status.trim().toLowerCase();
  return n === "canceled" || n === "cancelled" || n === "no_show";
}

/**
 * VERIFIED live 2026-08-05: the wire sends billingType "room", lowercase —
 * not the spec's schema name "RoomLineItem". Both stay accepted here (the
 * spec makes billingType the union's discriminator without publishing a
 * mapping, so hedging costs nothing). Anything unrecognized fails toward
 * "not a room charge", which degrades the booking to the even-split
 * fallback below instead of pricing a night off a pet fee.
 */
export function isThinkRoomCharge(item: Json): boolean {
  const raw = item.billingType;
  if (typeof raw !== "string") return false;
  const n = raw.toLowerCase().replace(/[^a-z]/g, "");
  return n === "roomlineitem" || n === "room" || n === "roomcharge";
}

/**
 * COMPLIANCE REQUIREMENT — DO NOT WEAKEN.
 * Maya's privacy policy states we never store guest personal data, and Think
 * reservations arrive soaked in it even though we never request the
 * read:customer scope: `customer` (name, email, phone, address),
 * `additionalGuestNames`, `dietaryRestrictions`, `specialAccommodations`,
 * `arrivalTime`, and a `customerName` on every line item. These are strict
 * allowlists in the mold of _shared/pms/redact.ts: any field not explicitly
 * listed is dropped, so new Think fields are excluded by default. Never add
 * guest-identifying fields to these lists.
 *
 * What survives is only what pricing analysis needs: booking structure (ids,
 * dates, room type), party-size counts, channel, and money totals.
 */
const RESERVATION_ALLOWLIST: readonly string[] = [
  "id",
  "confirmationId",
  "status",
  "channel",
  "createdAt",
  "updatedAt",
  "canceledAt",
];

const RESERVATION_TOTALS_ALLOWLIST: readonly string[] = ["subTotal", "taxes", "total"];

const BOOKING_ALLOWLIST: readonly string[] = [
  "id",
  "roomTypeId",
  "rateTypeId",
  "startDate",
  "endDate",
  "status",
  "numberOfGuests",
  "numberOfAdults",
  "numberOfChildren",
];

function pickScalars(payload: Json, allowlist: readonly string[]): Json {
  const out: Json = {};
  for (const key of allowlist) {
    const v = payload[key];
    // Only scalars survive — nested objects/arrays (customer, lineItems,
    // attributeValues) are either already parsed into columns or unneeded.
    if (v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    }
  }
  return out;
}

/** Redact a Think reservation + the one booking this row belongs to. */
export function redactThinkPayload(reservation: Json, booking: Json): Json {
  return {
    ...pickScalars(reservation, RESERVATION_ALLOWLIST),
    totals: pickScalars(reservation, RESERVATION_TOTALS_ALLOWLIST),
    booking: pickScalars(booking, BOOKING_ALLOWLIST),
    _redacted: true,
  };
}

export type ThinkParsedRow = {
  external_reservation_id: string;
  external_room_type_id: string | null;
  stay_date: string;
  booking_date: string | null;
  booking_window_days: number | null;
  current_rate: number | null;
  raw_payload: unknown;
};

/** Observability for ingest edge cases; same shape as the other ETLs. */
export type ThinkParseStats = {
  skippedMissingReservationId: number;
  skippedNoStayNights: number;
  duplicateStayNightKeysMerged: number;
  rowsWithMissingRate: number;
  skippedCanceled: number;
};

const emptyStats = (): ThinkParseStats => ({
  skippedMissingReservationId: 0,
  skippedNoStayNights: 0,
  duplicateStayNightKeysMerged: 0,
  rowsWithMissingRate: 0,
  skippedCanceled: 0,
});

/**
 * Room-charge line items for one booking. The spec exposes lineItems on the
 * reservation and again on each booking without saying whether one is a copy
 * of the other, and a charge read from both places doubles the booking's room
 * total — so the reservation-level list wins and the booking's own list is
 * only read when it is the only carrier. Reservation-level items are tied to
 * their booking by `bookingId` — except on a single-booking reservation,
 * where an item with no `bookingId` still belongs to the one stay there is.
 * The booking's own list is already scoped, so a missing join key there costs
 * nothing. Items flagged `canceled` are voided charges and must neither price
 * a night nor pad the fallback total.
 */
function roomChargesFor(
  reservation: Json,
  booking: Json,
  bookingId: string | null,
  isOnlyBooking: boolean,
): Json[] {
  const keep = (item: Json, unclaimedOk: boolean): boolean => {
    if (!isThinkRoomCharge(item) || item.canceled === true) return false;
    const itemBookingId = str(item.bookingId);
    if (itemBookingId === null) return unclaimedOk;
    return bookingId !== null && itemBookingId === bookingId;
  };

  const fromReservation = Array.isArray(reservation.lineItems)
    ? reservation.lineItems
        .filter((e): e is Json => !!asJson(e))
        .filter((item) => keep(item, isOnlyBooking))
    : [];
  if (fromReservation.length > 0) return fromReservation;

  return Array.isArray(booking.lineItems)
    ? booking.lineItems.filter((e): e is Json => !!asJson(e)).filter((item) => keep(item, true))
    : [];
}

export type ParsedThink = {
  rows: ThinkParsedRow[];
  canceledExternalIds: string[];
  stats: ThinkParseStats;
};

/**
 * Parse Think reservation objects into per-booking, per-night rows.
 *
 * Row keying: every booking's rows key by `${reservationId}:${bookingId}`,
 * single-booking stays included. Keying by the bare id when there is one
 * booking reads nicer but flips the key the moment a second room is added —
 * and nothing would ever clean up the rows written under the old keying,
 * so the stay double-counts forever (cloudbeds keys composite always for
 * the same reason). `canceledExternalIds` still carries the bare id next to
 * the composites so a row keyed by any earlier scheme dies with the stay.
 * The sync is expected to filter out ids it is actively writing before
 * deleting.
 */
export function parseThinkReservations(
  reservations: unknown[],
  opts: { hotelTimeZone: string },
): ParsedThink {
  const tz = opts.hotelTimeZone || "UTC";
  const stats = emptyStats();
  const byStayNight = new Map<string, ThinkParsedRow>();
  const canceled = new Set<string>();

  for (const entry of reservations) {
    const res = asJson(entry);
    const rid = res ? str(res.id) : null;
    if (!res || !rid) {
      stats.skippedMissingReservationId += 1;
      continue;
    }

    const bookings = Array.isArray(res.bookings)
      ? res.bookings.filter((b): b is Json => !!asJson(b))
      : [];
    // A booking with no id still needs a stable key; its position is the
    // only handle left.
    const bookingIdAt = (b: Json, idx: number) => str(b.id) ?? String(idx + 1);
    const externalIdAt = (b: Json, idx: number) => `${rid}:${bookingIdAt(b, idx)}`;

    if (isCanceledThinkStatus(res.status)) {
      canceled.add(rid);
      bookings.forEach((b, idx) => canceled.add(`${rid}:${bookingIdAt(b, idx)}`));
      stats.skippedCanceled += 1;
      continue;
    }

    if (bookings.length === 0) {
      stats.skippedNoStayNights += 1;
      continue;
    }

    // Same calendar as the stay nights, or an evening booking would read as
    // one day later than it was and shorten every lead time on the stay.
    const bookingDate = instantToHotelDate(res.createdAt, tz);

    for (let idx = 0; idx < bookings.length; idx += 1) {
      const booking = bookings[idx];
      const bid = bookingIdAt(booking, idx);

      if (isCanceledThinkStatus(booking.status)) {
        canceled.add(rid);
        canceled.add(`${rid}:${bid}`);
        stats.skippedCanceled += 1;
        continue;
      }

      const startDate = LEADING_YMD.exec(str(booking.startDate) ?? "")?.[1] ?? null;
      if (!startDate) {
        stats.skippedNoStayNights += 1;
        continue;
      }
      const endDate = LEADING_YMD.exec(str(booking.endDate) ?? "")?.[1] ?? null;
      const nights = enumerateNights(startDate, endDate);

      const externalId = externalIdAt(booking, idx);
      const roomTypeId = str(booking.roomTypeId);

      // `actualAmount` is the post-discount charge — the rate the night really
      // sold at; `amount` is the pre-discount list price, kept as fallback.
      const items = roomChargesFor(res, booking, str(booking.id), bookings.length === 1);
      const perNight = new Map<string, number>();
      let total = 0;
      let sawAmount = false;
      for (const item of items) {
        const amt = num(item.actualAmount) ?? num(item.amount);
        if (amt === null) continue;
        sawAmount = true;
        total += amt;
        const billedNight = instantToHotelDate(item.billingDate, tz);
        if (billedNight) perNight.set(billedNight, (perNight.get(billedNight) ?? 0) + amt);
      }
      // A night the line items never dated (summary billing, or billingDates
      // that fold onto no stay night) gets the even split of the booking's
      // room-line total, so revenue still lands even when its shape is lost.
      const fallbackNightly = sawAmount ? round2(total / nights.length) : null;

      for (const night of nights) {
        const matched = perNight.get(night);
        const key = `${externalId}:${night}`;
        if (byStayNight.has(key)) stats.duplicateStayNightKeysMerged += 1;
        byStayNight.set(key, {
          external_reservation_id: externalId,
          external_room_type_id: roomTypeId,
          stay_date: night,
          booking_date: bookingDate,
          booking_window_days: bookingDate ? bookingWindowFor(bookingDate, night) : null,
          current_rate: matched !== undefined ? round2(matched) : fallbackNightly,
          raw_payload: redactThinkPayload(res, booking),
        });
      }
    }
  }

  for (const row of byStayNight.values()) {
    if (row.current_rate === null) stats.rowsWithMissingRate += 1;
  }

  return {
    rows: [...byStayNight.values()],
    canceledExternalIds: [...canceled],
    stats,
  };
}
