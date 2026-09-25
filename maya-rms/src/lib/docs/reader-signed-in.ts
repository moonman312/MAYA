import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";

/**
 * Whether the docs reader behind this request is signed in to MAYA. Only the
 * yes or no is used: the docs routes never keep who it is.
 */
export async function readerSignedIn(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  try {
    const { data } = await createClient(await cookies()).auth.getUser();
    return Boolean(data.user);
  } catch {
    return false;
  }
}
