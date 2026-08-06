/**
 * Mews → Supabase row shapes. Mirrors `shared/legacy-python/etl.py` (field
 * detection, category names, Items-based rate lookup).
 */

import { addCalendarDays } from "../engine/timezone.ts";
import { redactMewsPayload } from "../pms/redact.ts";

type Json = Record<string, unknown>;

export type FieldMap = {
  reservation_id: string | null;
  stay_date: string | null;
  booking_date: string | null;
  room_type_id: string | null;
  rate: string | null;
};

const PREFERRED_LOCALES = ["en-US", "en-GB", "en-AU", "en"] as const;

export function getNested(obj: unknown, dottedKey: string | null): unknown {
  if (dottedKey === null || typeof obj !== "object" || obj === null) return undefined;
  let val: unknown = obj;
  for (const part of dottedKey.split(".")) {
    if (typeof val !== "object" || val === null) return undefined;
    val = (val as Json)[part];
  }
  return val;
}

export function detectField(sample: Json, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (getNested(sample, candidate) != null) return candidate;
  }
  return null;
}

export function detectFieldMap(sample: Json): FieldMap {
  return {
    reservation_id: detectField(sample, ["Id", "ReservationId", "id"]),
    stay_date: detectField(sample, [
      "ArrivalDate",
      "ScheduledStartUtc",
      "StartUtc",
      "CheckInUtc",
    ]),
    booking_date: detectField(sample, [
      "CreatedUtc",
      "Created",
      "BookingDate",
      "CreateDate",
    ]),
    room_type_id: detectField(sample, [
      "SpaceCategoryId",
      "RoomCategoryId",
      "ResourceCategoryId",
      "RequestedCategoryId",
    ]),
    rate: detectField(sample, [
      "StayPriceIncludingTaxes",
      "TotalAmount.Value",
      "Rate.Value",
      "Price.Value",
      "TotalPrice",
      "Amount",
    ]),
  };
}

function detectDepartureField(sample: Json): string | null {
  return detectField(sample, ["DepartureDate", "ScheduledEndUtc", "EndUtc", "CheckOutUtc"]);
}

function resolveCategoryName(cat: Json): string {
  const flat = cat.Name;
  if (typeof flat === "string" && flat) return flat;

  const names = cat.Names;
  if (names && typeof names === "object" && names !== null) {
    const dict = names as Record<string, string>;
    for (const loc of PREFERRED_LOCALES) {
      if (dict[loc]) return dict[loc];
    }
    const first = Object.values(dict)[0];
    if (first) return first;
  }

  const short = cat.ShortName;
  if (typeof short === "string" && short) return short;

  const shortNames = cat.ShortNames;
  if (shortNames && typeof shortNames === "object" && shortNames !== null) {
    const dict = shortNames as Record<string, string>;
    for (const loc of PREFERRED_LOCALES) {
      if (dict[loc]) return dict[loc];
    }
    const first = Object.values(dict)[0];
    if (first) return first;
  }

  return "Unknown";
}

export type CategoryInventoryEntry = { name: string; total_rooms: number };

/** Prefer explicit inventory fields from the PMS category payload; else use hotel default. */
function resolveCategoryRoomCount(cat: Json, fallback: number): number {
  const candidates: unknown[] = [
    cat.RoomCount,
    cat.SpacesCount,
    cat.ResourceCount,
    cat.InventoryCount,
  ];
  for (const raw of candidates) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.min(100_000, Math.floor(raw));
    }
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
      const n = parseInt(raw.trim(), 10);
      if (n > 0) return Math.min(100_000, n);
    }
  }
  return fallback;
}

export function buildCategoryInventory(
  data: Json,
  defaultRoomsPerCategory: number,
): Record<string, CategoryInventoryEntry> {
  const categories: Record<string, CategoryInventoryEntry> = {};
  for (const key of ["SpaceCategories", "RoomCategories", "ResourceCategories"] as const) {
    const items = data[key];
    if (!Array.isArray(items)) continue;
    for (const cat of items) {
      if (!cat || typeof cat !== "object") continue;
      const c = cat as Json;
      const id = c.Id ?? c.id;
      if (typeof id === "string" && id) {
        categories[id] = {
          name: resolveCategoryName(c),
          total_rooms: resolveCategoryRoomCount(c, defaultRoomsPerCategory),
        };
      }
    }
    break;
  }
  return categories;
}

export function buildCategoryMap(data: Json): Record<string, string> {
  const inv = buildCategoryInventory(data, 100);
  return Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v.name]));
}

/** Real Mews Ids are GUIDs, but a numeric one still has to dedupe. */
function itemDedupeKey(item: Json): string | null {
  const id = item.Id;
  if (typeof id === "string") return id || null;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

export function buildRateLookup(data: Json): Record<string, number> {
  const rateMap: Record<string, number> = {};
  const items = data.Items ?? data.OrderItems;
  if (!Array.isArray(items)) return rateMap;

  // The sync walks the range in 96h windows and Mews returns any stay that
  // collides with a window — plus that stay's whole order — in every window it
  // touches. The chunks are concatenated, so a stay crossing one boundary
  // arrives with its items twice and would sum to double the stay total.
  const countedItemIds = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const orderId = (item as Json).OrderId;
    if (typeof orderId !== "string" || !orderId) continue;
    const amount = (item as Json).Amount;
    if (!amount || typeof amount !== "object") continue;
    const a = amount as Json;
    const val = a.GrossValue ?? a.Value;
    if (val === null || val === undefined) continue;
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    const itemId = itemDedupeKey(item as Json);
    if (itemId !== null) {
      if (countedItemIds.has(itemId)) continue;
      countedItemIds.add(itemId);
    }
    rateMap[orderId] = (rateMap[orderId] ?? 0) + n;
  }
  return rateMap;
}

/** Mews service order state for canceled bookings (legacy + current APIs). */
export function isCanceledMewsReservation(raw: Json): boolean {
  const s = raw.State ?? raw.state;
  if (typeof s !== "string") return false;
  const n = s.trim().toLowerCase();
  return n === "canceled" || n === "cancelled";
}

export function findReservationsList(data: Json): Json[] {
  for (const key of ["Reservations", "reservations"] as const) {
    const items = data[key];
    if (Array.isArray(items) && items.length > 0) return items as Json[];
  }
  for (const key of ["Items", "items"] as const) {
    const items = data[key];
    if (Array.isArray(items) && items.length > 0) return items as Json[];
  }
  return [];
}

function extractRate(raw: Json, rateField: string | null): number | null {
  if (rateField) {
    let val = getNested(raw, rateField);
    if (val && typeof val === "object" && "Value" in (val as Json)) {
      val = (val as Json).Value;
    }
    if (val !== null && val !== undefined) {
      const n = Number(val);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

const ZONE_QUALIFIED = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LEADING_YMD = /^(\d{4}-\d{2}-\d{2})/;
const YMD_PARTS = { year: "numeric", month: "2-digit", day: "2-digit" } as const;

const formatterByTimeZone = new Map<string, Intl.DateTimeFormat>();

/**
 * One formatter per zone: a fleet sync parses tens of thousands of reservations
 * in a single invocation and building these per row costs more than the rest of
 * the parse put together. A junk `hotels.timezone` makes Intl throw, which would
 * fail the whole hotel instead of one row, so it degrades to UTC.
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
 * Mews names its instants `…Utc`, and those already fold in the property's local
 * check-in time — a 5pm Los Angeles arrival is midnight UTC the next day, so
 * truncating in UTC drops that arrival night. `ArrivalDate` and friends name a
 * civil day instead, and reading one of those as an instant shifts a hotel west
 * of Greenwich a day early — the same bug pointing the other way. Zone-less
 * timestamps are civil too: parsing them would use the machine's zone.
 */
function fieldToHotelDate(raw: Json, field: string | null, timeZone: string): string | null {
  if (!field) return null;
  const val = getNested(raw, field);
  if (typeof val !== "string") return null;
  const s = val.trim();
  if (!field.endsWith("Utc") || !ZONE_QUALIFIED.test(s)) {
    return LEADING_YMD.exec(s)?.[1] ?? null;
  }
  const d = new Date(s.replace(/Z$/, "+00:00"));
  if (Number.isNaN(d.getTime())) return null;
  if (timeZone === "UTC") return d.toISOString().slice(0, 10);
  return hotelDateFormatter(timeZone).format(d);
}

/**
 * Inclusive arrival, exclusive departure (hotel-night semantics), on the hotel's
 * own calendar. Same local day for arrival and departure yields a single stay night.
 */
export function enumerateStayNights(
  raw: Json,
  fieldMap: FieldMap,
  hotelTimeZone = "UTC",
): { nights: string[] } {
  const startStr = fieldToHotelDate(raw, fieldMap.stay_date, hotelTimeZone);
  if (!startStr) return { nights: [] };

  const endStr = fieldToHotelDate(raw, detectDepartureField(raw), hotelTimeZone);

  let nights: string[];
  if (!endStr || endStr <= startStr) {
    nights = [startStr];
  } else {
    nights = [];
    let cur = startStr;
    while (cur < endStr) {
      nights.push(cur);
      cur = addCalendarDays(cur, 1);
    }
  }

  return { nights };
}

/**
 * Lead time against the stay night itself, not arrival — night 2 of a stay
 * is one day further out than night 1, and pickup windows compare per-night.
 */
function bookingWindowFor(bookingDate: string, stay: string): number {
  const a = new Date(`${stay}T00:00:00Z`).getTime();
  const b = new Date(`${bookingDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((a - b) / 86400000));
}

export type ParsedRoomType = {
  external_room_type_id: string;
  name: string;
  display_name: string | null;
  /** Physical room count for this category; from PMS or `defaultRoomsPerCategory`. */
  total_rooms: number;
};

export type ParsedReservationRow = {
  external_reservation_id: string;
  external_room_type_id: string | null;
  stay_date: string;
  booking_date: string | null;
  booking_window_days: number | null;
  /** Nightly rate from Mews; `base_rate` in DB is set by trigger (original BAR). */
  current_rate: number | null;
  raw_payload: Json;
};

/** Observability for ingest edge cases (empty when there are no reservations in the payload). */
export type ParsedMewsStats = {
  skippedMissingReservationId: number;
  skippedNoStayNights: number;
  duplicateStayNightKeysMerged: number;
  rowsWithMissingRate: number;
  skippedCanceled: number;
};

const emptyStats = (): ParsedMewsStats => ({
  skippedMissingReservationId: 0,
  skippedNoStayNights: 0,
  duplicateStayNightKeysMerged: 0,
  rowsWithMissingRate: 0,
  skippedCanceled: 0,
});

export function parseMewsApiResponse(
  data: Json,
  options?: { defaultRoomsPerCategory?: number; hotelTimeZone?: string | null },
): {
  roomTypes: ParsedRoomType[];
  reservations: ParsedReservationRow[];
  stats: ParsedMewsStats;
  canceledExternalIds: string[];
} {
  const rawList = findReservationsList(data);
  if (rawList.length === 0) {
    return { roomTypes: [], reservations: [], stats: emptyStats(), canceledExternalIds: [] };
  }

  const fieldMap = detectFieldMap(rawList[0]);
  const tz = options?.hotelTimeZone || "UTC";
  const defaultRooms = options?.defaultRoomsPerCategory ?? 100;
  const categories = buildCategoryInventory(data, defaultRooms);
  const rateLookup = buildRateLookup(data);

  const roomTypes: ParsedRoomType[] = Object.entries(categories).map(([id, entry]) => ({
    external_room_type_id: id,
    name: entry.name,
    display_name: entry.name,
    total_rooms: entry.total_rooms,
  }));

  const stats = emptyStats();
  const byStayNight = new Map<string, ParsedReservationRow>();
  const canceledExternalIds = new Set<string>();

  for (const raw of rawList) {
    const rid = fieldMap.reservation_id ? getNested(raw, fieldMap.reservation_id) : null;
    if (typeof rid !== "string" || !rid) {
      stats.skippedMissingReservationId += 1;
      continue;
    }

    if (isCanceledMewsReservation(raw)) {
      canceledExternalIds.add(rid);
      stats.skippedCanceled += 1;
      continue;
    }

    const rtIdRaw = fieldMap.room_type_id ? getNested(raw, fieldMap.room_type_id) : null;
    const externalRoomTypeId = typeof rtIdRaw === "string" ? rtIdRaw : null;

    let rate = extractRate(raw, fieldMap.rate);
    if (rate === null && fieldMap.reservation_id) {
      const idKey = getNested(raw, fieldMap.reservation_id);
      if (typeof idKey === "string" && rateLookup[idKey] !== undefined) {
        rate = rateLookup[idKey];
      }
    }

    const { nights } = enumerateStayNights(raw, fieldMap, tz);
    if (nights.length === 0) {
      stats.skippedNoStayNights += 1;
      continue;
    }

    const denom = Math.max(1, nights.length);
    const nightly = rate !== null ? Math.round((rate / denom) * 100) / 100 : null;

    // Same calendar as the stay nights, or an evening booking would read as
    // one day later than it was and shorten every lead time on the stay.
    const bookingDate = fieldToHotelDate(raw, fieldMap.booking_date, tz);

    for (const night of nights) {
      const key = `${rid}:${night}`;
      const row: ParsedReservationRow = {
        external_reservation_id: rid,
        external_room_type_id: externalRoomTypeId,
        stay_date: night,
        booking_date: bookingDate,
        booking_window_days: bookingDate ? bookingWindowFor(bookingDate, night) : null,
        current_rate: nightly,
        raw_payload: redactMewsPayload(raw),
      };
      if (byStayNight.has(key)) {
        stats.duplicateStayNightKeysMerged += 1;
      }
      byStayNight.set(key, row);
    }
  }

  for (const row of byStayNight.values()) {
    if (row.current_rate === null) {
      stats.rowsWithMissingRate += 1;
    }
  }

  return {
    roomTypes,
    reservations: [...byStayNight.values()],
    stats,
    canceledExternalIds: [...canceledExternalIds],
  };
}
