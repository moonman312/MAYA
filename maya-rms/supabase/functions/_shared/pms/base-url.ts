/**
 * The address a PMS connection's calls go to, checked against the vendor's
 * own hosts before any credential is sent there (audit A34).
 *
 * pms_connections.base_url overrides the default host, which keeps a staging
 * proxy or a recorded fixture server possible. Every call for the hotel then
 * goes to that address with the hotel's access token, so a row pointing
 * anywhere else (written by hand, or by a member before members lost write
 * access to the table) would hand the token to whoever runs it, and the
 * prices MAYA reports as sent would never reach the PMS. Mews already refused
 * such an address (mews/constants.ts isAllowedMewsBaseUrl); Cloudbeds and
 * ThinkReservations now do too. An address the deployment set in its own
 * environment is trusted, because only the deployment can set it.
 *
 * An address that is not allowed is not used: the call goes to the default
 * host instead, and the refusal is logged, so a bad row can never stop a
 * hotel's pricing, and never sends its token anywhere but the vendor.
 */

/** The origin of an https address, or null. */
function httpsOrigin(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Whether `candidate` is on one of the vendor's hosts, or the host the deployment configured. */
export function isAllowedPmsBaseUrl(candidate: string, vendorOrigins: readonly string[], configured: string | undefined): boolean {
  const origin = httpsOrigin(candidate);
  if (!origin) return false;
  if (vendorOrigins.includes(origin)) return true;
  return configured != null && configured.startsWith("http") && httpsOrigin(configured) === origin;
}

/**
 * The stored address when it is allowed, else `fallback`. Trailing slash
 * trimmed. Logs once per call when a stored address is refused.
 */
export function pmsBaseUrlFor(
  stored: string | null | undefined,
  opts: { pms: string; hotelId?: string; fallback: string; vendorOrigins: readonly string[]; configured: string | undefined },
): string {
  const fallback = opts.fallback.replace(/\/$/, "");
  const value = typeof stored === "string" ? stored.trim() : "";
  if (!value) return fallback;
  if (isAllowedPmsBaseUrl(value, opts.vendorOrigins, opts.configured)) return value.replace(/\/$/, "");
  console.error(
    JSON.stringify({
      fn: "pmsBaseUrlFor",
      pms: opts.pms,
      hotelId: opts.hotelId ?? null,
      // The host only: a path or query could carry anything.
      refusedHost: httpsOrigin(value) ?? "not an https address",
      usingDefault: true,
    }),
  );
  return fallback;
}
