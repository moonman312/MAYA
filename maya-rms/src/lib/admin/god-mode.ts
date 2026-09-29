import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

/**
 * God Mode: a platform admin can open and view any property, and changes one
 * only inside a time-boxed support window opened with a code from their
 * authenticator app (99_supabase_migration_god_mode_v1.sql). The database
 * decides: god_mode_active() and god_mode_status() read the caller's JWT and
 * their open window, so everything here is asked of them with the caller's
 * own session client, never worked out from the cookie.
 */

/** What a route says when an admin outside God Mode tries to change a property. */
export const GOD_MODE_OFF =
  "God Mode is off. Turn it on from the Command Center to change this property.";

export type GodModeStatus = {
  /** The caller is a platform admin. False for everyone else, and God Mode is then never on. */
  admin: boolean;
  /** The JWT's assurance level: aal2 after a verified authenticator code. */
  aal: "aal1" | "aal2";
  /** A window is open and the token is aal2. */
  active: boolean;
  sessionId: string | null;
  startedAt: string | null;
  expiresAt: string | null;
};

const OFF: GodModeStatus = { admin: false, aal: "aal1", active: false, sessionId: null, startedAt: null, expiresAt: null };

/**
 * The caller's God Mode state, from the database. Any failure reads as off:
 * a database without the migration yet, or a call that errors, must never
 * open the door.
 */
export async function godModeStatus(ssr: SupabaseClient): Promise<GodModeStatus> {
  const { data, error } = await ssr.rpc("god_mode_status");
  if (error || !data || typeof data !== "object") return OFF;
  const s = data as Record<string, unknown>;
  const aal = s.aal === "aal2" ? "aal2" : "aal1";
  return {
    admin: s.admin === true,
    aal,
    active: s.active === true,
    sessionId: typeof s.session_id === "string" ? s.session_id : null,
    startedAt: typeof s.started_at === "string" ? s.started_at : null,
    expiresAt: typeof s.expires_at === "string" ? s.expires_at : null,
  };
}

export type GodModeSession = { id: string; startedAt: string | null; expiresAt: string | null };

/**
 * For a Command Center route that changes a property with the service role:
 * God Mode must be on for the caller, or the route answers 403 in plain words.
 * Called after requirePlatformAdmin, with its `ssr` client.
 */
export async function requireGodMode(
  ssr: SupabaseClient,
): Promise<{ ok: true; session: GodModeSession } | { ok: false; response: NextResponse }> {
  const status = await godModeStatus(ssr);
  if (!status.active || !status.sessionId) {
    return { ok: false, response: NextResponse.json({ error: GOD_MODE_OFF }, { status: 403 }) };
  }
  return { ok: true, session: { id: status.sessionId, startedAt: status.startedAt, expiresAt: status.expiresAt } };
}

export type SupportChange = {
  sessionId: string | null;
  userId: string;
  hotelId: string | null;
  tableName: string;
  rowId?: string | null;
  op: "insert" | "update" | "delete";
  before?: unknown;
  after?: unknown;
  /** One plain line, as the change log prints it after "Changed by MAYA support:". */
  summary: string;
};

/**
 * Records a change made in God Mode that the database's own trigger cannot
 * see, because the route wrote it with the service role. Never fails the
 * route: the change is already made, and a failed record is logged instead.
 */
export async function recordSupportChange(admin: SupabaseClient, change: SupportChange): Promise<void> {
  const { error } = await admin.from("support_changes").insert({
    session_id: change.sessionId,
    user_id: change.userId,
    hotel_id: change.hotelId,
    table_name: change.tableName,
    row_id: change.rowId ?? null,
    op: change.op,
    before: change.before ?? null,
    after: change.after ?? null,
    summary: change.summary,
  });
  if (error) {
    console.error(
      JSON.stringify({ fn: "recordSupportChange", hotelId: change.hotelId, table: change.tableName, error: error.message }),
    );
  }
}

/**
 * For a customer route an admin can also use (its gate is a hotel rank or
 * can_manage_hotel, then it writes with the service role): when the caller is
 * a platform admin in God Mode who is not a member of the property, the
 * change is recorded as support's. A member's own change is theirs, and is
 * never recorded here. Returns whether a row was written.
 */
export async function recordIfSupport(
  ssr: SupabaseClient,
  admin: SupabaseClient,
  change: Omit<SupportChange, "sessionId"> & { hotelId: string },
): Promise<boolean> {
  try {
    const { data: active } = await ssr.rpc("god_mode_active");
    if (active !== true) return false;
    const { data: rows } = await ssr
      .from("hotel_memberships")
      .select("id")
      .eq("hotel_id", change.hotelId)
      .eq("user_id", change.userId)
      .eq("status", "active")
      .limit(1);
    if (rows?.length) return false;
    const status = await godModeStatus(ssr);
    if (!status.active) return false;
    await recordSupportChange(admin, { ...change, sessionId: status.sessionId });
    return true;
  } catch (e) {
    // The change is already made; a record that could not be written is
    // logged, never turned into an error for the person who made it.
    console.error(
      JSON.stringify({
        fn: "recordIfSupport",
        hotelId: change.hotelId,
        table: change.tableName,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return false;
  }
}

/**
 * Which of these user ids belong to platform admins, so the change log can
 * say "MAYA support" instead of a staff member's name. Read with the service
 * role: app_roles is not readable through a customer's session. A client
 * that cannot read it names nobody, and the names stay as they are.
 */
export async function platformAdminIds(admin: SupabaseClient, userIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const { data, error } = await admin.from("app_roles").select("user_id").eq("role", "platform_admin").in("user_id", ids);
  if (error) return out;
  for (const row of data ?? []) if (typeof row.user_id === "string") out.add(row.user_id);
  return out;
}
