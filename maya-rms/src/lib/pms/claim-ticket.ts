/**
 * A Cloudbeds Marketplace claim ticket, kept in the browser while its owner
 * creates an account and confirms their email.
 *
 * The confirmation link often opens in a new tab, which shares localStorage
 * with the tab that signed up but not sessionStorage, so the ticket lives in
 * localStorage with the time it was saved. It is dropped once it is older than
 * the ticket itself can be: saved no earlier than Cloudbeds handed it over, it
 * can't still be valid after MARKETPLACE_CLAIM_TTL_MS. The server checks the
 * real expiry anyway; this only keeps a dead ticket from following the browser
 * around.
 *
 * Every storage call is wrapped: private browsing and blocked site data throw,
 * and the URL parameter still covers the direct path when they do.
 */

/** How long a claim ticket is valid after Connect App (marketplace-connect.ts sets expires_at from it). */
export const MARKETPLACE_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export const CLAIM_KEY = "maya.marketplace.claim";

/** The ticket this browser is holding, or null. Drops one that has run out. */
export function readClaimTicket(now: number = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(CLAIM_KEY);
    if (raw) {
      const { token, at } = JSON.parse(raw) as { token?: unknown; at?: unknown };
      if (
        typeof token === "string" &&
        token &&
        typeof at === "number" &&
        Math.abs(now - at) <= MARKETPLACE_CLAIM_TTL_MS
      ) {
        return token;
      }
      localStorage.removeItem(CLAIM_KEY);
    }
  } catch {
    try {
      localStorage.removeItem(CLAIM_KEY);
    } catch {
      // storage unavailable
    }
  }

  // A tab that was open across the deploy kept a bare ticket in sessionStorage.
  // Read it once and move it over.
  try {
    const legacy = sessionStorage.getItem(CLAIM_KEY);
    if (legacy) {
      sessionStorage.removeItem(CLAIM_KEY);
      saveClaimTicket(legacy, now);
      return legacy;
    }
  } catch {
    // storage unavailable
  }
  return null;
}

export function saveClaimTicket(token: string, now: number = Date.now()) {
  try {
    localStorage.setItem(CLAIM_KEY, JSON.stringify({ token, at: now }));
  } catch {
    // storage unavailable
  }
}

export function forgetClaimTicket() {
  try {
    localStorage.removeItem(CLAIM_KEY);
  } catch {
    // storage unavailable
  }
  try {
    sessionStorage.removeItem(CLAIM_KEY);
  } catch {
    // storage unavailable
  }
}
