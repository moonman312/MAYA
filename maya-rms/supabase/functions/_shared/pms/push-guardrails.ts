/**
 * The last check before a price leaves MAYA, and the reason codes the rate
 * ledger records when a cell is held back.
 *
 * The engine clamps to floor and ceiling when it publishes, but a row in
 * published_price is not proof of a good number at the moment of sending. A
 * room type can be switched off after its nights were priced, a floor can be
 * raised after a night was published, a manager's session can write the
 * table directly, and a row outlives the evaluation that wrote it. So
 * pushRatesForHotel checks every cell it is about to send against the room
 * type as it is right now. A cell that fails is not sent, and is written to
 * rate_updates as status 'skipped' with its code in `error`.
 *
 * THE CODES ARE A CONTRACT. Failure classification reads them. Never rename or
 * reuse one; add a new one. When more than one applies, the first in
 * GUARDRAIL_ORDER is the one recorded.
 *
 *   guardrail:outside_window       The stay date is not a night of the push
 *                                  window [hotel today, today + horizon - 1],
 *                                  or is not a date at all.
 *   guardrail:inactive_room_type   The room type is switched off in MAYA
 *                                  (room_types.is_active is not true).
 *   guardrail:invalid_price        The price is not a finite number above 0.
 *   guardrail:zero_base            The PMS's own rate for the night is 0 in
 *                                  base_rate_calendar (closed, or rates not
 *                                  loaded that far out) and nobody typed a
 *                                  manual price for it. The engine leaves
 *                                  such a night unpriced; this catches a row
 *                                  left over from before it did.
 *   guardrail:invalid_bounds       The room type's floor or ceiling is not a
 *                                  usable number (missing, not above 0, or a
 *                                  ceiling under the floor), so the price
 *                                  cannot be checked against them.
 *   guardrail:below_floor          The price is under the room type's floor
 *                                  as it is now (the $1.00 default included).
 *   guardrail:above_ceiling        The price is over the room type's ceiling
 *                                  as it is now ($99,999.99 default included).
 *   guardrail:stale_price          Neither the published row nor any
 *                                  evaluation of the hotel is newer than
 *                                  pushMaxPriceAgeMs(). The engine writes a
 *                                  row only when its price or base moves, so
 *                                  an old computed_at alone is not stale: a
 *                                  recent successful evaluation re-derived
 *                                  every priced night in the window.
 *
 * One older skip reason is not a guardrail and keeps its original text:
 *
 *   "no rate target for room type" (NO_RATE_TARGET_REASON)  The PMS has no
 *                                  base rate for the room type, so there is
 *                                  nothing to send to.
 *
 * Rows with status 'failed' carry the vendor's own error text, cut to 300
 * characters, never a code.
 *
 * `attempts` on a skipped row says whether MAYA's rate may be in the PMS for
 * that night: 0 means nothing was ever sent to it (every attempt so far was
 * skipped), 1 means an earlier send or failed send happened. The base rate
 * calendar keeps re-reading a night whose row says 0.
 */

import { mwsEnv } from "../mews/env.ts";

export const GUARDRAIL = {
  outsideWindow: "guardrail:outside_window",
  inactiveRoomType: "guardrail:inactive_room_type",
  invalidPrice: "guardrail:invalid_price",
  zeroBase: "guardrail:zero_base",
  invalidBounds: "guardrail:invalid_bounds",
  belowFloor: "guardrail:below_floor",
  aboveCeiling: "guardrail:above_ceiling",
  stalePrice: "guardrail:stale_price",
} as const;

export type GuardrailCode = (typeof GUARDRAIL)[keyof typeof GUARDRAIL];

/** Precedence, first wins. Structural reasons before the one that clears itself on the next evaluation. */
export const GUARDRAIL_ORDER: readonly GuardrailCode[] = [
  GUARDRAIL.outsideWindow,
  GUARDRAIL.inactiveRoomType,
  GUARDRAIL.invalidPrice,
  GUARDRAIL.zeroBase,
  GUARDRAIL.invalidBounds,
  GUARDRAIL.belowFloor,
  GUARDRAIL.aboveCeiling,
  GUARDRAIL.stalePrice,
];

/** The skip reason for a room type the PMS has no base rate for. Predates the codes; kept as written. */
export const NO_RATE_TARGET_REASON = "no rate target for room type";

const DEFAULT_MAX_PRICE_AGE_MINUTES = 30;

/**
 * How old the newest evidence for a price may be before it is not sent, from
 * MAYA_PUSH_MAX_PRICE_AGE_MINUTES. Thirty minutes is six scheduled ticks at
 * the default five-minute interval: a hotel whose evaluation has failed for
 * that long stops pushing until one succeeds.
 */
export function pushMaxPriceAgeMs(raw: string | undefined = mwsEnv("MAYA_PUSH_MAX_PRICE_AGE_MINUTES")): number {
  const n = Number(raw);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PRICE_AGE_MINUTES) * 60_000;
}

export type GuardrailRoomType = {
  isActive: unknown;
  floorPrice: unknown;
  ceilingPrice: unknown;
};

export type GuardrailInput = {
  stayDate: string;
  price: number;
  roomType: GuardrailRoomType;
  /** The push window, both ends inclusive, YYYY-MM-DD. */
  firstDate: string;
  lastDate: string;
  /** base_rate_calendar holds 0 for the night and no manual price is open. */
  zeroBase: boolean;
  /** published_price.computed_at of the row, ms; NaN when missing. */
  computedAtMs: number;
  /** The newest evaluation known for the hotel, ms; NaN when unknown. */
  evaluatedAtMs: number;
  /** Evidence older than this (ms) is stale. */
  freshAfterMs: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Money compared in whole cents, as the numeric(10,2) columns store it. */
function cents(n: number): number {
  return Math.round(n * 100);
}

/** The code a cell is held back for, or null when it may be sent. */
export function checkPushGuardrails(c: GuardrailInput): GuardrailCode | null {
  if (!ISO_DATE.test(c.stayDate) || c.stayDate < c.firstDate || c.stayDate > c.lastDate) {
    return GUARDRAIL.outsideWindow;
  }
  if (c.roomType.isActive !== true) return GUARDRAIL.inactiveRoomType;
  if (typeof c.price !== "number" || !Number.isFinite(c.price) || cents(c.price) <= 0) return GUARDRAIL.invalidPrice;
  if (c.zeroBase) return GUARDRAIL.zeroBase;
  const floor = c.roomType.floorPrice == null ? NaN : Number(c.roomType.floorPrice);
  const ceiling = c.roomType.ceilingPrice == null ? NaN : Number(c.roomType.ceilingPrice);
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling) || cents(floor) <= 0 || cents(ceiling) < cents(floor)) {
    return GUARDRAIL.invalidBounds;
  }
  if (cents(c.price) < cents(floor)) return GUARDRAIL.belowFloor;
  if (cents(c.price) > cents(ceiling)) return GUARDRAIL.aboveCeiling;
  if (!(c.computedAtMs >= c.freshAfterMs) && !(c.evaluatedAtMs >= c.freshAfterMs)) return GUARDRAIL.stalePrice;
  return null;
}

/**
 * Whether a rate_updates row says MAYA never sent anything to its night: a
 * skipped row with attempts 0. Every other row, whatever its status, may sit
 * over an earlier send the PMS still holds.
 */
export function ledgerRowNeverSent(row: { status?: unknown; attempts?: unknown } | null | undefined): boolean {
  if (!row) return true;
  return row.status === "skipped" && row.attempts != null && Number(row.attempts) === 0;
}
