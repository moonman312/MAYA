/**
 * How the rules table's stops route (src/app/api/rules/stops/route.ts, which
 * may export only its handlers) reads stopped nights: every one still to
 * come, and the passed ones of the rules it shows, a page at a time.
 */
/** Rows per page, PostgREST's own cap. */
export const STOPPED_NIGHTS_PAGE = 1000;
/** Pages read at most per read: 40 rules stopped over the whole 396-night window is 16. */
export const STOPPED_NIGHTS_MAX_PAGES = 40;
/**
 * Nights one "Let it run again" can name: one rule's stopped nights, the 396
 * ahead at most and the ones that have passed since its version was saved.
 */
export const MAX_RESUME_NIGHTS = 5000;
