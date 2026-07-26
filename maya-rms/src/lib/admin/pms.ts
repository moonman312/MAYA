import "server-only";
import { mewsConfigurationGet } from "@/lib/mews/client";
import { summarizeEnterprise } from "@/lib/mews/resolve-credentials";
import type { ResolvedMewsCredentials } from "@/lib/mews/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const MEWS_BASE_URLS = {
  demo: "https://api.mews-demo.com/api/connector/v1",
  production: "https://api.mews.com/api/connector/v1",
} as const;

export type MewsEnv = keyof typeof MEWS_BASE_URLS;

export type SetMewsCredentialsInput = {
  hotelId: string;
  env: MewsEnv;
  clientToken: string;
  accessToken: string;
  enterpriseId?: string;
};

export function baseUrlForEnv(env: MewsEnv): string {
  return MEWS_BASE_URLS[env];
}

/**
 * Test a Mews connection using in-memory credentials (not yet saved).
 * Returns the enterprise info Mews reports back.
 */
export async function testMewsConnection(
  input: SetMewsCredentialsInput,
): Promise<{ enterprise: { name: string; id: string } }> {
  const creds: ResolvedMewsCredentials = {
    clientToken: input.clientToken,
    accessToken: input.accessToken,
    enterpriseId: input.enterpriseId,
    baseUrl: baseUrlForEnv(input.env),
  };
  const config = (await mewsConfigurationGet(creds)) as Record<string, unknown>;
  return { enterprise: summarizeEnterprise(config) };
}

/**
 * Persist Mews credentials to Vault and upsert the pms_connections row.
 * Requires admin (service-role) client.
 */
export async function saveMewsCredentials(
  admin: SupabaseClient,
  input: SetMewsCredentialsInput,
  opts: { markConnected?: boolean } = {},
): Promise<void> {
  const secret = {
    clientToken: input.clientToken,
    accessToken: input.accessToken,
    ...(input.enterpriseId ? { enterpriseId: input.enterpriseId } : {}),
    env: input.env,
  };

  const { error: secretErr } = await admin.rpc("pms_secret_set", {
    p_hotel_id: input.hotelId,
    p_pms_type: "mews",
    p_secret: secret,
  });
  if (secretErr) throw new Error(`pms_secret_set: ${secretErr.message}`);

  const now = new Date().toISOString();
  const { error: pcErr } = await admin
    .from("pms_connections")
    .upsert(
      {
        hotel_id: input.hotelId,
        pms_type: "mews",
        base_url: baseUrlForEnv(input.env),
        status: opts.markConnected ? "connected" : "pending",
        last_tested_at: opts.markConnected ? now : null,
        updated_at: now,
      },
      { onConflict: "hotel_id,pms_type" },
    );
  if (pcErr) throw new Error(`pms_connections upsert: ${pcErr.message}`);

  await admin.rpc("platform_log_event", {
    p_event_type: opts.markConnected ? "pms.connected" : "pms.saved",
    p_entity_type: "pms_connection",
    p_entity_id: input.hotelId,
    p_hotel_id: input.hotelId,
    p_detail: { env: input.env },
  });
}

export async function deleteMewsCredentials(
  admin: SupabaseClient,
  hotelId: string,
): Promise<void> {
  const { error: secErr } = await admin.rpc("pms_secret_delete", {
    p_hotel_id: hotelId,
    p_pms_type: "mews",
  });
  if (secErr) throw new Error(`pms_secret_delete: ${secErr.message}`);

  const { error: pcErr } = await admin
    .from("pms_connections")
    .update({ status: "disconnected", updated_at: new Date().toISOString() })
    .eq("hotel_id", hotelId)
    .eq("pms_type", "mews");
  if (pcErr) throw new Error(`pms_connections status update: ${pcErr.message}`);

  await admin.rpc("platform_log_event", {
    p_event_type: "pms.disconnected",
    p_entity_type: "pms_connection",
    p_entity_id: hotelId,
    p_hotel_id: hotelId,
  });
}
