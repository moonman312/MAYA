/**
 * getReservationsWithRateDetails payloads for tests. Keys and value types are
 * the ones the sandbox returned on 2026-09-16; every value is invented, and
 * the guest fields carry a placeholder so redaction has something to drop.
 */

export type Json = Record<string, unknown>;

export type RoomFixture = {
  /** subReservationID: the booking's own id for its first room, `<id>-<n>` for the rest. */
  sub: string;
  roomTypeID?: string;
  /** {date: amount}, one entry per night the room holds. Omit for a room whose payload lost its rates. */
  rates?: Record<string, number | null>;
  roomID?: string | null;
  /** Cloudbeds' own word for the room: "not_checked_in" unless said otherwise. */
  roomStatus?: string;
};

export const PLACEHOLDER_GUEST = "Guest Placeholder";

export function nightsBetween(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${checkIn}T00:00:00Z`); d.toISOString().slice(0, 10) < checkOut; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** The same rate on every night from check-in to check-out. */
export function flatRates(checkIn: string, checkOut: string, rate: number): Record<string, number> {
  return Object.fromEntries(nightsBetween(checkIn, checkOut).map((n) => [n, rate]));
}

export function rateDetailsBooking(opts: {
  id: string;
  status: string;
  checkIn: string;
  checkOut: string;
  rooms?: RoomFixture[];
  /** Same nightly rate on every night of one room, when `rooms` is omitted. */
  nightly?: number;
  created?: string;
  modified?: string;
  isDeleted?: boolean;
}): Json {
  const rooms: RoomFixture[] =
    opts.rooms ?? [{ sub: opts.id, rates: flatRates(opts.checkIn, opts.checkOut, opts.nightly ?? 200) }];
  const detailedRates: Record<string, number> = {};
  for (const room of rooms) {
    for (const [date, amount] of Object.entries(room.rates ?? {})) {
      detailedRates[date] = (detailedRates[date] ?? 0) + (amount ?? 0);
    }
  }
  const total = Object.values(detailedRates).reduce((s, n) => s + n, 0);
  const created = `${opts.created ?? "2026-07-01"} 09:30:00`;
  const modified = opts.modified ?? created;
  const canceled = opts.status === "canceled" || opts.status === "no_show";
  return {
    reservationID: opts.id,
    isDeleted: opts.isDeleted ?? false,
    dateCreated: created,
    dateCreatedUTC: created,
    dateModified: modified,
    dateModifiedUTC: modified,
    status: opts.status,
    reservationCheckIn: opts.checkIn,
    reservationCheckOut: opts.checkOut,
    guestID: "900000001",
    profileID: "900000002",
    guestName: PLACEHOLDER_GUEST,
    guestCountry: "XX",
    propertyID: "prop-1",
    thirdPartyIdentifier: "",
    estimatedArrivalTime: null,
    total,
    balance: total,
    dateImported: null,
    sourceName: "Website/Booking Engine",
    source: { name: "Website/Booking Engine", paymentCollect: "hotel", sourceID: "s-1" },
    propertyCurrency: "USD",
    balanceDetailed: { suggestedDeposit: 0, subTotal: total, taxesFees: 0, additionalItems: 0, grandTotal: total, paid: 0 },
    allotmentBlockCode: null,
    origin: "",
    detailedRates,
    rooms: rooms.map((room) => ({
      roomTypeID: room.roomTypeID ?? "RT1",
      roomTypeIsVirtual: false,
      roomTypeName: room.roomTypeID === "RT2" ? "Queen" : "King",
      subReservationID: room.sub,
      isRoomLocked: false,
      guestID: "900000001",
      guestName: PLACEHOLDER_GUEST,
      rateID: "700001",
      rateName: "Standard",
      adults: "2",
      children: "0",
      roomID: room.roomID ?? null,
      roomCheckIn: opts.checkIn,
      roomCheckOut: opts.checkOut,
      roomStatus: room.roomStatus ?? "not_checked_in",
      ...(room.rates ? { detailedRoomRates: room.rates } : {}),
      detailedRoomRateNames: [],
      ratePlanNamePrivate: null,
      ratePlanNamePublic: null,
      marketName: "Direct",
      marketCode: "direct",
      roomName: room.roomID ? `Room ${room.roomID}` : null,
    })),
    guestList: {},
    mealPlans: "",
    ...(canceled ? { dateCancelled: modified, dateCancelledUTC: modified } : {}),
  };
}

export type RateDetailsQuery = { checkOutFrom: string; checkOutTo?: string; modifiedFrom?: string };

/**
 * One page of the book the way the sandbox showed the server behaves: it
 * filters by check-out and modifiedFrom, ignores status, and pages at 100
 * with a total.
 */
export function rateDetailsPage(
  book: Json[],
  query: RateDetailsQuery,
  pageNumber: number,
): { reservations: Json[]; hasMore: boolean; total: number } {
  const matched = book.filter(
    (b) =>
      String(b.reservationCheckOut) >= query.checkOutFrom &&
      (query.checkOutTo === undefined || String(b.reservationCheckOut) <= query.checkOutTo) &&
      (query.modifiedFrom === undefined || String(b.dateModified) >= query.modifiedFrom),
  );
  const start = (pageNumber - 1) * 100;
  return {
    reservations: matched.slice(start, start + 100),
    hasMore: start + 100 < matched.length,
    total: matched.length,
  };
}
