/**
 * Which Terms of Service and Privacy Policy a person is agreeing to.
 *
 * Both documents live on the marketing site (maya-marketing/app/terms and
 * maya-marketing/app/privacy), and each page states its version. Bump the
 * matching constant here in the same change that publishes new wording there:
 * every signed-in user who has not accepted the new pair is asked once, and a
 * version recorded against wording that was never published proves nothing.
 *
 * Safe to import from client components.
 */

export const TERMS_VERSION = "1";
export const PRIVACY_VERSION = "2";

export const TERMS_URL = "https://www.get-maya.com/terms";
export const PRIVACY_URL = "https://www.get-maya.com/privacy";

/** Where the acceptance happened. Mirrors the check constraint on terms_acceptances.context. */
export type AcceptanceContext = "signup" | "claim" | "invite" | "reaccept";

/**
 * Key under the Supabase user metadata that carries a signup's acceptance
 * through an email confirmation. The database trigger reads exactly this key.
 */
export const SIGNUP_ACCEPTANCE_KEY = "maya_terms";

export type SignupAcceptance = {
  terms_version: string;
  privacy_version: string;
  context: "signup" | "claim";
  user_agent?: string;
};

/** The `options.data` for supabase.auth.signUp once the box is ticked. */
export function signupAcceptanceMetadata(
  context: "signup" | "claim",
  userAgent?: string,
): Record<typeof SIGNUP_ACCEPTANCE_KEY, SignupAcceptance> {
  return {
    [SIGNUP_ACCEPTANCE_KEY]: {
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      context,
      ...(userAgent ? { user_agent: userAgent.slice(0, 512) } : {}),
    },
  };
}

/** True when signup metadata carries acceptance of the versions in force now. */
export function metadataAcceptsCurrent(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const entry = (metadata as Record<string, unknown>)[SIGNUP_ACCEPTANCE_KEY];
  if (!entry || typeof entry !== "object") return false;
  const { terms_version, privacy_version } = entry as Record<string, unknown>;
  return terms_version === TERMS_VERSION && privacy_version === PRIVACY_VERSION;
}

/**
 * Pages where the accept screen must never cover the page: signing in or
 * creating an account already carries its own checkbox, and an invite is
 * accepted on its own form.
 */
export function isAcceptanceExemptPath(pathname: string | null | undefined): boolean {
  if (!pathname) return true;
  return pathname === "/login" || pathname.startsWith("/login/") || pathname.startsWith("/auth/");
}
