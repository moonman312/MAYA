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
 *
 * Above all of that sits the number a human typed for the cell (manual_price).
 * It has to be the top slot: the scheduled tick re-resolves every base from
 * scratch, so a manual number anywhere lower is outranked by the calendar and
 * never reaches the PMS. A guest booking taken at the manual price echoes
 * back as a reservation base_rate equal to it, which cannot displace it —
 * the ratchet stays dead.
 */

export type BasePriceSources = {
  /** A rate someone typed for the cell (open manual_price row). Wins outright. */
  manual?: number;
  /** The property's own rate from base_rate_calendar. Authoritative. */
  calendar?: number;
  /** Newest reservation's base_rate for the cell — may be a price WE set. */
  reservation?: number | null;
  /** published_price.base_price remembered from a previous run. */
  remembered?: number;
};

export type BaseSource = "manual" | "calendar" | "reservation" | "remembered";

/**
 * The base for a cell and which tier supplied it, or undefined when nothing
 * is known and the cell must be skipped.
 */
export function resolveBase(
  src: BasePriceSources,
): { price: number; source: BaseSource } | undefined {
  // `!= null` rather than truthiness throughout: a genuine 0 (comp or
  // house-use night, or a manual 0) is a real rate, and treating it as
  // missing sent the cell down the fallback path for no reason.
  if (src.manual != null) return { price: src.manual, source: "manual" };
  if (src.calendar != null) return { price: src.calendar, source: "calendar" };
  if (src.reservation != null) return { price: src.reservation, source: "reservation" };
  if (src.remembered != null) return { price: src.remembered, source: "remembered" };
  return undefined;
}

/** The base for a cell, or undefined when nothing is known and it must be skipped. */
export function resolveBasePrice(src: BasePriceSources): number | undefined {
  return resolveBase(src)?.price;
}
