/**
 * Shapes for the slice of the ThinkReservations API that MAYA reads.
 *
 * Every field is optional and null-tolerant: these interfaces describe what
 * the ETL consumes, not everything the server promises, and a missing field
 * must degrade to a skipped row rather than a crashed sync.
 *
 * COMPLIANCE — the omissions are the point. Reservation payloads carry guest
 * fields even without the read:customer scope (arrivalTime,
 * dietaryRestrictions, specialAccommodations, additionalGuestNames on the
 * reservation; customerName, notes and createdBy on line items; customerId
 * always). None of them are typed here, deliberately: MAYA never stores
 * guest personal data, and a field the compiler has never heard of is one
 * downstream code cannot quietly reach for. Anything persisted to
 * raw_payload additionally passes redactThinkPayload's strict allowlist in
 * ./etl.ts. Never add guest-identifying fields to these interfaces.
 */

export type ThinkCredentials = {
  accessToken: string;
  /** Think API origin, e.g. https://api.thinkreservations.com */
  baseUrl: string;
};

/**
 * A billed line on a reservation or booking. `billingType` is the wire's
 * discriminator — the room / item / package / pet / additional-guest /
 * gift-certificate subtypes all flatten onto these same fields.
 */
export interface ThinkLineItem {
  id?: string | null;
  billingType?: string | null;
  bookingId?: string | null;
  roomId?: string | null;
  billingDate?: string | null;
  quantity?: number | null;
  amountPerUnit?: number | null;
  amount?: number | null;
  discountedAmount?: number | null;
  actualAmount?: number | null;
  canceled?: boolean | null;
  fee?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** A single room stay within a reservation — the unit stay-nights come from. */
export interface ThinkBooking {
  id?: string | null;
  roomId?: string | null;
  roomTypeId?: string | null;
  rateTypeId?: string | null;
  /** Check-in date, YYYY-MM-DD. */
  startDate?: string | null;
  /** Check-out date, YYYY-MM-DD. */
  endDate?: string | null;
  numberOfGuests?: number | null;
  numberOfAdults?: number | null;
  numberOfChildren?: number | null;
  /** checked_in | checked_out | scheduled | canceled | no_show */
  status?: string | null;
  lineItems?: ThinkLineItem[] | null;
  canceledAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ThinkReservation {
  id?: string | null;
  confirmationId?: string | null;
  /** checked_in | checked_out | scheduled | canceled | no_show */
  status?: string | null;
  bookings?: ThinkBooking[] | null;
  lineItems?: ThinkLineItem[] | null;
  channel?: string | null;
  subTotal?: number | null;
  taxes?: number | null;
  total?: number | null;
  canceledAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * The slice of the Spring page envelope the pager consumes. The wire carries
 * more (pageable, sort, totalElements, first, empty); the client narrows to
 * the four fields a walk actually steers by.
 */
export interface ThinkPage<T> {
  content: T[];
  totalPages: number;
  last: boolean;
  number: number;
}
