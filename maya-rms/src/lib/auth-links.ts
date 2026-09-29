import { isAuthError, isAuthRetryableFetchError } from "@supabase/supabase-js";

/**
 * Why a link from one of our emails (an invitation, a password reset) did not
 * sign someone in, in the only terms that change what they should do next.
 *
 *   expired        The link can't be used again. It ran out, was already
 *                  clicked, or a newer one replaced it. Supabase answers all of
 *                  these the same way (otp_expired), so the page can't tell
 *                  them apart either.
 *   other-browser  A link from the code flow, opened in a browser other than
 *                  the one that asked for it. That browser holds the other half
 *                  of the code; nothing else can redeem it.
 *   retry          Nothing was decided: no answer came back, or Supabase was
 *                  busy or down. The same link can still work on a reload.
 */
export type LinkProblem = "expired" | "other-browser" | "retry";

export function linkProblem(error: unknown): LinkProblem {
  if (isAuthRetryableFetchError(error)) return "retry";
  if (!isAuthError(error)) return "retry";
  if (error.code === "pkce_code_verifier_not_found") return "other-browser";
  const status = error.status ?? 0;
  if (status === 429 || status >= 500) return "retry";
  return "expired";
}

/**
 * True when Supabase has already turned the link down and says so in the
 * address it sent the person to (?error_code=otp_expired, or the same in the
 * fragment for older links).
 */
export function linkRefusedInUrl(href: string): boolean {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  return [url.searchParams, fragment].some((p) => p.has("error_code") || p.has("error"));
}
