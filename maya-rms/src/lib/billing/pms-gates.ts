import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-PMS control over whether checkout requires an access code.
 *
 * The access code is a system-wide gate today. This is the lever for opening
 * specific integrations to self-serve independently of each other, once each
 * has proven out — Cloudbeds open, Think Reservations still invite-only, say —
 * without ever touching the gate as a single on/off switch.
 *
 * This governs the ACCESS code only. A discount or trial code, if the customer
 * has one, is validated and honoured by checkCode/checkoutEffectFor exactly the
 * same regardless of which way a gate here is set — that part of the system
 * doesn't change when self-serve opens up.
 */

export type PmsSignupGate = {
  pmsType: string;
  requiresSignupCode: boolean;
  updatedAt: string | null;
};

/**
 * Every configured gate, for the Command Center toggle list.
 */
export async function listPmsSignupGates(admin: SupabaseClient): Promise<PmsSignupGate[]> {
  const { data, error } = await admin
    .from("pms_signup_gates")
    .select("pms_type, requires_signup_code, updated_at")
    .order("pms_type", { ascending: true });
  if (error) throw new Error(`Could not load PMS signup gates: ${error.message}`);

  return (data ?? []).map((row) => ({
    pmsType: String(row.pms_type),
    requiresSignupCode: row.requires_signup_code !== false,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  }));
}

/**
 * Whether checkout may proceed with no access code for this PMS.
 *
 * Missing row or a failed read both answer `true` — required. The cost of that
 * default is a confused admin wondering why a gate they thought they set isn't
 * there yet; the cost of the opposite default is an unvetted signup reaching a
 * paid subscription with nothing checked. Only one of those is the kind of
 * mistake that's easy to notice and impossible to undo.
 */
export async function pmsSignupCodeRequired(
  admin: SupabaseClient,
  pmsType: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("pms_signup_gates")
    .select("requires_signup_code")
    .eq("pms_type", pmsType)
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ fn: "pmsSignupCodeRequired", pmsType, error: error.message }),
    );
    return true;
  }
  if (!data) return true;
  return data.requires_signup_code !== false;
}

/**
 * Flip one PMS's gate. Platform-admin only — enforced by the caller
 * (requirePlatformAdmin gates the API route before this ever runs), not by RLS,
 * since the table has no policy for anyone but the service role at all.
 */
export async function setPmsSignupCodeRequired(
  admin: SupabaseClient,
  pmsType: string,
  required: boolean,
  actorUserId: string,
): Promise<void> {
  const { error } = await admin
    .from("pms_signup_gates")
    .upsert(
      {
        pms_type: pmsType,
        requires_signup_code: required,
        updated_at: new Date().toISOString(),
        updated_by: actorUserId,
      },
      { onConflict: "pms_type" },
    );
  if (error) throw new Error(`Could not update the signup gate for ${pmsType}: ${error.message}`);

  // Best-effort: the gate change already landed, and failing the whole request
  // over an audit-log write would leave an admin unsure whether their change
  // took effect when it actually did.
  const { error: logErr } = await admin.rpc("platform_log_event", {
    p_event_type: "pms_signup_gate.changed",
    p_entity_type: "pms_signup_gate",
    p_entity_id: pmsType,
    p_detail: { pms_type: pmsType, requires_signup_code: required },
  });
  if (logErr) {
    console.error(
      JSON.stringify({ fn: "setPmsSignupCodeRequired", pmsType, error: logErr.message }),
    );
  }
}
