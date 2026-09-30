/**
 * The signed-in person's own display choices on their profile row: today,
 * the text size. Read and written through their own client, so
 * profiles_update keeps each person to their own row.
 */

import { isMissingColumnError } from "@/lib/engine/snapshots";
import { isTextSize, type TextSize } from "@/lib/text-size";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The person's saved text size, or null when it cannot be read (a database before the migration, a failed read). */
export async function readTextSize(supabase: SupabaseClient, userId: string): Promise<TextSize | null> {
  try {
    const { data, error } = await supabase.from("profiles").select("text_size").eq("id", userId).maybeSingle();
    if (error || !data) return null;
    const v = (data as { text_size?: unknown }).text_size;
    return isTextSize(v) ? v : null;
  } catch {
    return null;
  }
}

export type SaveTextSizeResult = { ok: true } | { ok: false; reason: "pre_migration" | "no_row" | "failed"; message: string };

export async function saveTextSize(supabase: SupabaseClient, userId: string, size: TextSize): Promise<SaveTextSizeResult> {
  const { data, error } = await supabase.from("profiles").update({ text_size: size }).eq("id", userId).select("id");
  if (error) {
    return { ok: false, reason: isMissingColumnError(error) ? "pre_migration" : "failed", message: error.message };
  }
  if (!data || data.length === 0) return { ok: false, reason: "no_row", message: "no profile row" };
  return { ok: true };
}
