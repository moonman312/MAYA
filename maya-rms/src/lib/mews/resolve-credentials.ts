import { defaultMewsBaseUrl } from "@/lib/mews/constants";
import type { MewsCredentialsInput, ResolvedMewsCredentials } from "@/lib/mews/types";
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

function parseCredentialsJson(text: string): MewsCredentialsInput | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    return normalizeKeys(raw as Record<string, unknown>);
  } catch {
    return null;
  }
}

export type ResolveMewsCredentialsResult = {
  creds: ResolvedMewsCredentials;
  connectionId: string | null;
  source: "body" | "database" | "environment";
};

/**
 * Resolves Mews tokens: optional request body overrides, then `pms_connections`
 * for the hotel (`credentials_encrypted` stores JSON for now), then server env.
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

  const { data: row, error } = await supabase
    .from("pms_connections")
    .select("id, credentials_encrypted, base_url")
    .eq("hotel_id", hotelId)
    .eq("pms_type", "mews")
    .maybeSingle();

  if (error) {
    return { error: error.message };
  }

  if (row?.credentials_encrypted) {
    const parsed = parseCredentialsJson(row.credentials_encrypted);
    if (parsed) {
      const baseUrl = (row.base_url || parsed.baseUrl || defaultMewsBaseUrl()).replace(/\/$/, "");
      return {
        creds: { ...parsed, baseUrl },
        connectionId: row.id as string,
        source: "database",
      };
    }
  }

  const clientToken = process.env.MEWS_CLIENT_TOKEN ?? process.env.MEWS_DEMO_CLIENT_TOKEN;
  const accessToken = process.env.MEWS_ACCESS_TOKEN ?? process.env.MEWS_DEMO_ACCESS_TOKEN;
  if (clientToken && accessToken) {
    return {
      creds: {
        clientToken,
        accessToken,
        enterpriseId: process.env.MEWS_ENTERPRISE_ID || undefined,
        baseUrl: defaultMewsBaseUrl(),
      },
      connectionId: null,
      source: "environment",
    };
  }

  return {
    error:
      "No Mews credentials: add a `pms_connections` row (pms_type=mews) with JSON in " +
      "`credentials_encrypted` ({ clientToken, accessToken, enterpriseId? }), " +
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
