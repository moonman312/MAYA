/**
 * The comparable-date search's tunables, on their own so the browser can
 * quote them (the "Show the numbers" panel, src/lib/explain.ts) without
 * bundling the search, the season detection and the holiday calendar.
 * comparable-dates.ts re-exports them.
 */

export const MAX_COMPARABLES = 8;
export const MIN_TARGET_COMPARABLES = 4;
export const MAX_YEARS_BACK = 3;
/** Fallback season window (± days around the target's day of year) when no season model exists. */
export const NO_MODEL_SEASON_SPAN_DAYS = 45;
