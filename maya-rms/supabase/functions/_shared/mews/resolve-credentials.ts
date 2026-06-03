import { defaultMewsBaseUrl } from "./constants.ts";
import { mwsEnv } from "./env.ts";
import type { MewsCredentialsInput, ResolvedMewsCredentials } from "./types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

function normalizeKeys(raw: Record<string, unknown>): MewsCredentialsInput | null {
  const clientToken =
    (typeof raw.clientToken === "string" && raw.clientToken) ||
    (typeof raw.client_token === "string" && raw.client_token) ||
    "";
  const accessToken =
    (typeof raw.accessToken === "string" && raw.accessToken) ||
    (typeof raw.access_token === "string" && raw.access_token) ||
    "";
  if (!clientToken || !accessToken) return null;
  const enterpriseId =
    (typeof raw.enterpriseId === "string" && raw.enterpriseId) ||
    (typeof raw.enterprise_id === "string" && raw.enterprise_id) ||
    undefined;
  const baseUrl =
    (typeof raw.baseUrl === "string" && raw.baseUrl) ||
    (typeof raw.base_url === "string" && raw.base_url) ||
    undefined;
  return {
    clientToken,
    accessToken,
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/**
 * Normalizes whatever `pms_secret_get` returns. PostgREST decodes Postgres
 * `jsonb` into a JS object directly, but a defensive parse keeps us safe if
 * the column is ever returned as a string.
 */
function normalizeSecretPayload(raw: unknown): MewsCredentialsInput | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      return normalizeKeys(parsed as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    return normalizeKeys(raw as Record<string, unknown>);
  }
  return null;
}

export type ResolveMewsCredentialsResult = {
  creds: ResolvedMewsCredentials;
  connectionId: string | null;
  source: "body" | "database" | "environment";
};

/**
 * Resolves Mews tokens in priority order:
 *   1. Request body override (test-before-save flow).
 *   2. Vault-backed secret for the hotel via the `pms_secret_get` RPC.
 *   3. Server-side env fallback (`MEWS_CLIENT_TOKEN` + `MEWS_ACCESS_TOKEN`).
 *
 * The credentials column was retired in the PMS Secrets v1 migration — the
 * actual token bytes never traverse PostgREST anymore. Authorization for the
 * RPC is enforced server-side: service_role bypasses; JWT callers must satisfy
 * `can_manage_hotel(hotel_id)`.
 */
export async function resolveMewsCredentials(
  supabase: SupabaseClient,
  hotelId: string,
  bodyOverride?: MewsCredentialsInput | null,
): Promise<ResolveMewsCredentialsResult | { error: string }> {
  if (bodyOverride?.clientToken && bodyOverride?.accessToken) {
    return {
      creds: {
        clientToken: bodyOverride.clientToken,
        accessToken: bodyOverride.accessToken,
        enterpriseId: bodyOverride.enterpriseId,
        baseUrl: (bodyOverride.baseUrl ?? defaultMewsBaseUrl()).replace(/\/$/, ""),
      },
      connectionId: null,
      source: "body",
    };
  }

  // Metadata only — never `credentials_encrypted` (column no longer exists).
  const { data: row, error: rowErr } = await supabase
    .from("pms_connections")
    .select("id, base_url")
    .eq("hotel_id", hotelId)
    .eq("pms_type", "mews")
    .maybeSingle();

  if (rowErr) {
    return { error: rowErr.message };
  }

  if (row?.id) {
    const { data: secret, error: secretErr } = await supabase.rpc("pms_secret_get", {
      p_hotel_id: hotelId,
      p_pms_type: "mews",
    });
    if (secretErr) {
      return { error: secretErr.message };
    }
    const parsed = normalizeSecretPayload(secret);
    if (parsed) {
      const baseUrl = (row.base_url || parsed.baseUrl || defaultMewsBaseUrl()).replace(/\/$/, "");
      return {
        creds: { ...parsed, baseUrl },
        connectionId: row.id as string,
        source: "database",
      };
    }
  }

  const clientToken = mwsEnv("MEWS_CLIENT_TOKEN") ?? mwsEnv("MEWS_DEMO_CLIENT_TOKEN");
  const accessToken = mwsEnv("MEWS_ACCESS_TOKEN") ?? mwsEnv("MEWS_DEMO_ACCESS_TOKEN");
  if (clientToken && accessToken) {
    return {
      creds: {
        clientToken,
        accessToken,
        enterpriseId: mwsEnv("MEWS_ENTERPRISE_ID") || undefined,
        baseUrl: defaultMewsBaseUrl(),
      },
      /** Keep row id when a `pms_connections` row exists so sync can update `last_sync_at` / `status`. */
      connectionId: row?.id != null ? String(row.id) : null,
      source: "environment",
    };
  }

  return {
    error:
      "No Mews credentials: create a `pms_connections` row (pms_type=mews) and call " +
      "the `pms_secret_set` RPC with { clientToken, accessToken, enterpriseId? }, " +
      "pass mews in the request body, or set MEWS_CLIENT_TOKEN + MEWS_ACCESS_TOKEN.",
  };
}

export function summarizeEnterprise(config: Record<string, unknown>): {
  name: string;
  id: string;
} {
  let enterprise: unknown = config.Enterprise ?? config.Enterprises;
  if (Array.isArray(enterprise)) {
    enterprise = enterprise[0] ?? {};
  }
  if (typeof enterprise !== "object" || enterprise === null) {
    return { name: "(unknown)", id: "(unknown)" };
  }
  const e = enterprise as Record<string, unknown>;
  return {
    name: typeof e.Name === "string" ? e.Name : "(unknown)",
    id: typeof e.Id === "string" ? e.Id : "(unknown)",
  };
}
