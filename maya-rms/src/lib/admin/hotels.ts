import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminHotelRow } from "./types";

export type ListHotelsOptions = { search?: string };

export async function listHotels(
  ssr: SupabaseClient,
  opts: ListHotelsOptions = {},
): Promise<AdminHotelRow[]> {
  const { data, error } = await ssr.rpc("platform_list_hotels", {
    p_search: opts.search ?? null,
  });
  if (error) throw new Error(`platform_list_hotels: ${error.message}`);
  return (data ?? []) as AdminHotelRow[];
}

export async function getHotel(
  ssr: SupabaseClient,
  hotelId: string,
): Promise<AdminHotelRow | null> {
  const rows = await listHotels(ssr);
  return rows.find((r) => r.id === hotelId) ?? null;
}

export type CreateHotelInput = {
  name: string;
  timezone: string;
  currency: string;
  total_rooms_per_type: number;
  external_enterprise_id?: string | null;
  pricing_horizon_days?: number;
  pickup_window_cycles?: number;
  simulation_mode?: boolean;
  rounding_mode?: string;
};

export type CreateHotelResult = {
  hotelId: string;
};

/**
 * Creates a hotel + hotel_settings using the service-role admin client.
 * Because we're using service_role, RLS is bypassed and the trigger detects
 * platform admins via auth.uid() being null → auto-membership is skipped.
 */
export async function createHotel(
  admin: SupabaseClient,
  input: CreateHotelInput,
): Promise<CreateHotelResult> {
  const { data: hotel, error: hotelErr } = await admin
    .from("hotels")
    .insert({
      name: input.name,
      timezone: input.timezone,
      currency: input.currency,
      total_rooms_per_type: input.total_rooms_per_type,
      external_enterprise_id: input.external_enterprise_id ?? null,
      is_active: true,
    })
    .select("id")
    .single();

  if (hotelErr || !hotel) {
    throw new Error(`Failed to create hotel: ${hotelErr?.message ?? "unknown"}`);
  }

  const { error: settingsErr } = await admin.from("hotel_settings").upsert({
    hotel_id: hotel.id,
    pricing_horizon_days: input.pricing_horizon_days ?? 365,
    pickup_window_cycles: input.pickup_window_cycles ?? 1,
    simulation_mode: input.simulation_mode ?? true,
    rounding_mode: input.rounding_mode ?? "none",
  });

  if (settingsErr) {
    throw new Error(`Hotel created (${hotel.id}) but settings failed: ${settingsErr.message}`);
  }

  await admin.rpc("platform_log_event", {
    p_event_type: "hotel.created",
    p_entity_type: "hotel",
    p_entity_id: hotel.id,
    p_hotel_id: hotel.id,
    p_detail: { name: input.name },
  });

  return { hotelId: hotel.id };
}

export type UpdateHotelInput = Partial<
  Pick<
    AdminHotelRow,
    "name" | "timezone" | "currency" | "total_rooms_per_type" | "is_active" | "external_enterprise_id"
  >
>;

export async function updateHotel(
  admin: SupabaseClient,
  hotelId: string,
  patch: UpdateHotelInput,
): Promise<void> {
  const { error } = await admin
    .from("hotels")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", hotelId);
  if (error) throw new Error(`Failed to update hotel: ${error.message}`);

  await admin.rpc("platform_log_event", {
    p_event_type: "hotel.updated",
    p_entity_type: "hotel",
    p_entity_id: hotelId,
    p_hotel_id: hotelId,
    p_detail: patch as Record<string, unknown>,
  });
}
