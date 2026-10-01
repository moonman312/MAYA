/**
 * Floors and ceilings as the setup review and the go-live confirm show them
 * (Jake, 2026-09-30, audit A21).
 *
 * The import still writes a floor and a ceiling from the property's own rates
 * (supabase/functions/_shared/onboarding/analysis.ts applyInitialGuardrails),
 * on top of the ones the answers set. The review lists each one with a remove
 * that puts it back to no limit, and the go-live confirm counts the nights
 * whose own rate in the PMS sits outside them, since going live sends those
 * nights moved inside with no rule behind it (rates-outside-limits.ts).
 *
 * Plain values only, so the review screen can use them in the browser.
 */

/** The schema's defaults, which mean no limit: a floor of 1.00 and a ceiling of 99,999.99. */
export const NO_FLOOR = 1;
export const NO_CEILING = 99_999.99;

/** A floor someone or something set (the defaults, and anything at or under 1.00, are none: suggest.ts reads them so). */
export function hasFloor(floor: unknown): boolean {
  const n = Number(floor);
  return Number.isFinite(n) && n > NO_FLOOR;
}

/** A ceiling someone or something set: anything but exactly the default (a ceiling of 150,000 is set). */
export function hasCeiling(ceiling: unknown): boolean {
  const n = Number(ceiling);
  return Number.isFinite(n) && Math.abs(n - NO_CEILING) >= 0.005;
}

export type LimitKind = "floor" | "ceiling";

/** The room_types column and the value that means no limit, for a remove. */
export function noLimitPatch(kind: LimitKind): { floor_price: number } | { ceiling_price: number } {
  return kind === "floor" ? { floor_price: NO_FLOOR } : { ceiling_price: NO_CEILING };
}

