import "server-only";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client for server-side admin operations.
 *
 * BYPASSES RLS entirely. Only call this from server components / route
 * handlers / server actions that have already verified the caller is a
 * platform admin (see `requirePlatformAdmin`). Never expose to client code.
 *
 * Env required:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY (NOT prefixed with NEXT_PUBLIC_)
 */
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Set SUPABASE_SERVICE_ROLE_KEY in .env.local (dev) and Vercel env (prod).",
    );
  }
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function isAdminConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}
