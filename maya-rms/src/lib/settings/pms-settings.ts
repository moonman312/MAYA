/**
 * The property's setting for rates MAYA sent that are then changed or removed
 * in its property system (hotel_settings.pms_rate_changes, Jake 2026-09-30):
 * "Keep the change as your price" (keep, the default) or "MAYA's price wins"
 * (maya_wins). Only for the systems MAYA reads such changes from, Cloudbeds
 * and ThinkReservations; a Mews property has no such section.
 *
 * Read through the person's own client (anyone on the property may read the
 * settings row), and saved through set_pms_rate_changes, which takes the same
 * can_manage_hotel check as every property setting and, when turning "MAYA's
 * price wins" on, asks before it replaces rates kept from the PMS
 * (99_supabase_migration_pms_rate_changes_v1.sql).
 */

import { isMissingColumnError } from "@/lib/engine/snapshots";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pmsName } from "../../../supabase/functions/_shared/pms/push-failure";

export const PMS_RATE_CHANGE_MODES = ["keep", "maya_wins"] as const;
export type PmsRateChangeMode = (typeof PMS_RATE_CHANGE_MODES)[number];

export function isPmsRateChangeMode(v: unknown): v is PmsRateChangeMode {
  return typeof v === "string" && (PMS_RATE_CHANGE_MODES as readonly string[]).includes(v);
}

/** The systems MAYA reads changed rates from. */
export const READS_RATE_CHANGES = new Set(["cloudbeds", "think"]);

export type PmsSettings = {
  /** The property system in service. */
  type: "cloudbeds" | "think";
  /** Its name as the app writes it: "Cloudbeds", "Think Reservations". */
  name: string;
  mode: PmsRateChangeMode;
};

/** The words on the screen, for the setting and its two choices. */
export const PMS_CHANGES_LABELS = {
  question: (pms: string) => `When a price MAYA sent is changed in ${pms}`,
  keep: "Keep the change as your price",
  maya_wins: "MAYA's price wins",
} as const;

/** What turning "MAYA's price wins" on replaces, as the confirm step says it. */
export function replaceLine(nights: number, pms: string): string {
  return `${nights} ${nights === 1 ? "night keeps" : "nights keep"} a rate changed in ${pms}. MAYA will replace them with its prices.`;
}

let loggedPreMigration = false;

/**
 * The setting, for a property on Cloudbeds or ThinkReservations; null for any
 * other (Mews, no connection yet) or when the connection can't be read. A
 * database before the migration reads as Keep, which is how MAYA worked.
 */
export async function readPmsSettings(supabase: SupabaseClient, hotelId: string): Promise<PmsSettings | null> {
  try {
    const { data: connections, error } = await supabase
      .from("pms_connections")
      .select("pms_type, status, updated_at")
      .eq("hotel_id", hotelId);
    if (error) throw error;
    const rows = ((connections ?? []) as { pms_type?: unknown; status?: unknown; updated_at?: unknown }[]).sort((a, b) =>
      String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")),
    );
    const row = rows.find((r) => r.status === "connected") ?? rows[0];
    const type = row ? String(row.pms_type) : "";
    if (!READS_RATE_CHANGES.has(type)) return null;

    const { data, error: settingsError } = await supabase.from("hotel_settings").select("pms_rate_changes").eq("hotel_id", hotelId).maybeSingle();
    if (settingsError && !isMissingColumnError(settingsError)) throw settingsError;
    if (settingsError && !loggedPreMigration) {
      loggedPreMigration = true;
      console.warn(
        JSON.stringify({
          fn: "pms-settings",
          step: "pre-migration",
          hotelId,
          message: "hotel_settings.pms_rate_changes is missing. Showing Keep. Run 99_supabase_migration_pms_rate_changes_v1.sql.",
        }),
      );
    }
    const mode = (data as { pms_rate_changes?: unknown } | null)?.pms_rate_changes;
    return { type: type as PmsSettings["type"], name: pmsName(type), mode: isPmsRateChangeMode(mode) ? mode : "keep" };
  } catch (e) {
    console.error(JSON.stringify({ fn: "pms-settings", step: "read", hotelId, error: e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e) }));
    return null;
  }
}

export type SavePmsResult =
  | { ok: true; mode: PmsRateChangeMode; replaced: number }
  | { ok: false; reason: "confirm"; nights: number }
  | { ok: false; reason: "pre_migration" | "refused" | "no_row" | "failed"; message: string };

/**
 * Saves the setting. Turning "MAYA's price wins" on while future nights keep
 * a rate changed in the PMS answers `confirm` with how many, and saves
 * nothing, unless `replace` is set: then those rates are handed back to MAYA
 * in the same transaction. Prices typed in MAYA are never touched.
 */
export async function savePmsRateChanges(
  supabase: SupabaseClient,
  hotelId: string,
  mode: PmsRateChangeMode,
  replace: boolean,
): Promise<SavePmsResult> {
  const { data, error } = await supabase.rpc("set_pms_rate_changes", { p_hotel_id: hotelId, p_mode: mode, p_replace: replace });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "PGRST202" || /could not find the function/i.test(error.message)) return { ok: false, reason: "pre_migration", message: error.message };
    if (code === "42501") return { ok: false, reason: "refused", message: error.message };
    return { ok: false, reason: "failed", message: error.message };
  }
  const r = (data ?? {}) as { saved?: unknown; reason?: unknown; nights?: unknown; cleared_prices?: unknown; handed_back?: unknown };
  if (r.saved === true) return { ok: true, mode, replaced: Number(r.nights) || 0 };
  if (r.reason === "confirm") return { ok: false, reason: "confirm", nights: Number(r.nights) || 0 };
  if (r.reason === "no_row") return { ok: false, reason: "no_row", message: "no hotel_settings row" };
  return { ok: false, reason: "failed", message: `unexpected answer: ${JSON.stringify(data)}` };
}
