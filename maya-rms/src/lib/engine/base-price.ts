/**
 * Which number the rules get applied to, for one cell.
 *
 * The order is the whole point. A reservation's base_rate is filled by the
 * reservations_sync_base_rate trigger from current_rate — what the guest
 * actually paid — and neither PMS ETL supplies it. So once MAYA pushed an
 * adjusted rate and someone booked at it, that booking came back through the
 * sync and became the cell's base: the rule had not re-fired (ladder rules
 * correctly stay quiet while their condition holds), but the number underneath
 * it had moved, and only ever upward. When the rule later deactivated, the cell
 * reverted to the RAISED number instead of the property's own rate, while cells
 * that never sold reverted correctly. Measured on the sandbox: $200 -> $230
 * published -> booked at $230 -> $264.50 -> reverted to $230.
 *
 * So the property's own rate, captured from the PMS before we ever wrote to
 * that cell, outranks anything derived from a booking.
 */

export type BasePriceSources = {
  /** The property's own rate from base_rate_calendar. Authoritative. */
  calendar?: number;
  /** Newest reservation's base_rate for the cell — may be a price WE set. */
  reservation?: number | null;
  /** published_price.base_price remembered from a previous run. */
  remembered?: number;
};

/** The base for a cell, or undefined when nothing is known and it must be skipped. */
export function resolveBasePrice(src: BasePriceSources): number | undefined {
  if (src.calendar != null) return src.calendar;
  // `!= null` rather than truthiness: a genuine 0 base_rate (comp or house-use
  // night) is a real rate, and treating it as missing sent the cell down the
  // fallback path for no reason.
  if (src.reservation != null) return src.reservation;
  if (src.remembered != null) return src.remembered;
  return undefined;
}
