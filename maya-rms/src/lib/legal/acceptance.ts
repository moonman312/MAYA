import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import { PRIVACY_VERSION, TERMS_VERSION, type AcceptanceContext } from "@/lib/legal/versions";

/**
 * Reading and writing terms_acceptances.
 *
 * Everything here fails OPEN for the person and LOUD for us. The table arrives
 * in its own migration and this code can be deployed ahead of it; a missing
 * table, or a database that is briefly unreachable, must never stand between a
 * paying hotel and its dashboard. It is logged so the gap is seen, and the
 * accept screen simply asks again once the record can be kept.
 */

export type AcceptanceState = "accepted" | "missing" | "unavailable";

export type RecordResult = "recorded" | "duplicate" | "unavailable" | "failed";

const MIGRATION = "99_supabase_migration_terms_acceptance_v1.sql";

function logUnavailable(step: string, error: unknown) {
  const missing = isMissingRelationError(error);
  console.error(
    JSON.stringify({
      fn: "termsAcceptance",
      step,
      ...(missing
        ? { warning: `terms_acceptances is missing, acceptance is NOT being recorded. Run ${MIGRATION}` }
        : { error: error instanceof Error ? error.message : describe(error) }),
    }),
  );
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Has this user accepted the versions in force now? Asked with the user's own
 * session, which RLS limits to their own rows.
 */
export async function currentAcceptance(
  supabase: SupabaseClient,
  userId: string,
): Promise<AcceptanceState> {
  try {
    const { data, error } = await supabase
      .from("terms_acceptances")
      .select("id")
      .eq("user_id", userId)
      .eq("terms_version", TERMS_VERSION)
      .eq("privacy_version", PRIVACY_VERSION)
      .limit(1);
    if (error) {
      logUnavailable("read", error);
      return "unavailable";
    }
    return data && data.length > 0 ? "accepted" : "missing";
  } catch (e) {
    logUnavailable("read", e);
    return "unavailable";
  }
}

/**
 * Turn a signup's metadata into a row when the database trigger did not. The
 * function reads auth.users itself, so nothing the browser sends now counts.
 */
export async function adoptSignupAcceptance(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("record_terms_acceptance_from_signup", {
      p_user_id: userId,
    });
    if (error) {
      logUnavailable("adopt_signup", error);
      return false;
    }
    return data === true;
  } catch (e) {
    logUnavailable("adopt_signup", e);
    return false;
  }
}

export type AcceptanceInput = {
  userId: string;
  email: string | null;
  context: AcceptanceContext;
  hotelId: string | null;
  ip: string | null;
  userAgent: string | null;
};

/**
 * Write one acceptance of the current versions, as service role. accepted_at
 * is left to the database default on purpose.
 *
 * A second click, another tab, or a retry after a slow response would each
 * write the same event again, so an identical row already on file answers
 * "duplicate" instead.
 */
export async function recordAcceptance(
  admin: SupabaseClient,
  input: AcceptanceInput,
): Promise<RecordResult> {
  try {
    let existing = admin
      .from("terms_acceptances")
      .select("id")
      .eq("user_id", input.userId)
      .eq("terms_version", TERMS_VERSION)
      .eq("privacy_version", PRIVACY_VERSION)
      .eq("context", input.context);
    existing = input.hotelId ? existing.eq("hotel_id", input.hotelId) : existing.is("hotel_id", null);
    const { data: found, error: findErr } = await existing.limit(1);
    if (findErr) {
      logUnavailable("find_existing", findErr);
      return isMissingRelationError(findErr) ? "unavailable" : "failed";
    }
    if (found && found.length > 0) return "duplicate";

    const { error } = await admin.from("terms_acceptances").insert({
      user_id: input.userId,
      email: input.email,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      context: input.context,
      hotel_id: input.hotelId,
      ip: input.ip,
      user_agent: input.userAgent,
      source: "app",
    });
    if (error) {
      logUnavailable("insert", error);
      return isMissingRelationError(error) ? "unavailable" : "failed";
    }
    return "recorded";
  } catch (e) {
    logUnavailable("insert", e);
    return "failed";
  }
}

/**
 * The address the request came from. The hosting edge overwrites
 * x-real-ip and x-forwarded-for with the connecting address, so on the
 * deployed app these are observed rather than asserted; locally they are
 * whatever the dev server saw. Kept as evidence, never used for access.
 */
export function requestIp(headers: Headers): string | null {
  const real = headers.get("x-real-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = real || forwarded || "";
  return ip ? ip.slice(0, 64) : null;
}

export function requestUserAgent(headers: Headers): string | null {
  const ua = headers.get("user-agent")?.trim() ?? "";
  return ua ? ua.slice(0, 512) : null;
}
