/**
 * Telling "these Mews keys stopped working" apart from everything else a read
 * can fail with.
 *
 * Mews connects with a ClientToken and an AccessToken, not a grant, and
 * nothing on Mews' side tells MAYA when a property revokes the integration or
 * rotates its token. Until this existed the sync only ever wrote 'connected',
 * so a property whose keys died read Connected, with no banner, for as long as
 * anyone cared to look (G54).
 *
 * Mews answers bad credentials with 401. Its 403 is a validation error meant
 * for the end user (a reservation that can't be changed, say), so a 403 only
 * counts when its message is about the tokens. 429, 5xx, timeouts and
 * malformed replies are outages, not refusals, and never count.
 *
 * Several refusals in a row, not one: a single 401 during a Mews deploy or a
 * token rotation that lands mid-run is not worth an Error banner and an email
 * to the General Manager an hour later.
 */

/** Refused reads in a row before the connection reads Error. */
export const MEWS_AUTH_FAILURES_BEFORE_ERROR = 3;

const TOKEN_WORDS = ["accesstoken", "clienttoken"];
const REFUSAL_WORDS = ["invalid", "expired", "disabled", "revoked", "notvalid", "unauthorized", "unauthorised"];

export function isMewsAuthFailure(
  status: number | null | undefined,
  message?: string | null,
): boolean {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  // "Invalid AccessToken", "The access token is disabled": spacing and case vary.
  const m = (message ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  return TOKEN_WORDS.some((w) => m.includes(w)) && REFUSAL_WORDS.some((w) => m.includes(w));
}
