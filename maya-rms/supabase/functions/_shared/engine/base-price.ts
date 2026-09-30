/**
 * Which number the rules get applied to, for one cell.
 *
 * Two sources, and only two:
 *
 *   manual    A price someone typed for the night (an open manual_price row),
 *             or one the hotel set in its PMS on a night MAYA had sent to.
 *             Wins outright. It has to be the top slot: the scheduled tick
 *             re-resolves every base from scratch, so a typed number anywhere
 *             lower would be outranked and never reach the PMS.
 *   calendar  The property's own rate for the night, read from the PMS into
 *             base_rate_calendar before MAYA ever wrote to that cell.
 *
 * A night with neither is not priced. It used to fall back to the newest
 * booking's base_rate, and then to the base remembered from an earlier run.
 * A booking's rate is what the guest paid, which after MAYA's first send is
 * MAYA's own price coming back: with a +10% rule a $200 night went out at
 * $220, was booked at $220, became $242, then $266.20, and an OTA promo
 * booking at $150 dropped it to $165. It also put a price on a night the
 * hotel had never loaded a rate for. The remembered base was that same number
 * kept from run to run. Decided 2026-09-29 (audit A6): a night with no rate
 * on record from the PMS, and no typed price, stays unpriced and is never
 * sent until the PMS has a rate for it.
 *
 * A calendar row the PMS did not return on its last read is not a rate on
 * record either: evaluate.ts leaves out rows past the last night that read
 * returned (pms_connections.base_rates_returned_through).
 */

export type BasePriceSources = {
  /** A rate someone typed for the cell (open manual_price row). Wins outright. */
  manual?: number;
  /** The property's own rate from base_rate_calendar, as far as the last read returned it. */
  calendar?: number;
};

export type BaseSource = "manual" | "calendar";

/**
 * The base for a cell and which tier supplied it, or undefined when nothing
 * is on record and the cell must be skipped.
 */
export function resolveBase(
  src: BasePriceSources,
): { price: number; source: BaseSource } | undefined {
  // `!= null` rather than truthiness throughout: a genuine 0 (comp or
  // house-use night, or a manual 0) is a real rate, and treating it as
  // missing sent the cell down the fallback path for no reason.
  if (src.manual != null) return { price: src.manual, source: "manual" };
  if (src.calendar != null) return { price: src.calendar, source: "calendar" };
  return undefined;
}

/**
 * Whether the engine prices a cell on the base it resolved.
 *
 * A base of 0 that did not come from a person is a night the hotel has closed
 * or not loaded rates for yet. Pricing it clamped the 0 up to the floor, and
 * the push then opened the night at the floor: $1 with the default, or $89 on
 * a night the hotel meant to keep shut. So such a cell is left unpriced, and
 * only a price someone typed for it (a manual 0 included, which is a reset
 * point like any other) puts MAYA's number on it. A base that is not a number
 * at all is never priced.
 */
export function pricesOnBase(base: { price: number; source: BaseSource }): boolean {
  if (!Number.isFinite(base.price)) return false;
  return base.price > 0 || base.source === "manual";
}

/** The base for a cell, or undefined when nothing is on record and it must be skipped. */
export function resolveBasePrice(src: BasePriceSources): number | undefined {
  return resolveBase(src)?.price;
}
