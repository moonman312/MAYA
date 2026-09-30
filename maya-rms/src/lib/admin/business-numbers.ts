import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A property's business numbers, night by night, for the Command Center:
 * staff_hotel_business_numbers() in 99_supabase_migration_staff_roles_v1.sql.
 * Read under the caller's own session, so the database decides: a platform
 * admin for any property, a sales login at aal2 for real (not test) ones
 * only, nobody else. Totals only, the way the property's calendar adds a
 * night up; nothing about a booking or a guest.
 */

export type BusinessNight = {
  stayDate: string;
  roomsSold: number;
  /** Rooms of the types that count as rooms, less rooms out of service. */
  roomsAvailable: number;
  /** Sellable occupancy, one decimal. Null when no room is available. */
  occupancyPct: number | null;
  /** Every active type's revenue, as the calendar's day total. */
  roomRevenue: number;
  /** Revenue of the types that count as rooms over rooms sold. Null with nothing sold. */
  adr: number | null;
};

export type BusinessTotals = {
  roomsSold: number;
  roomsAvailable: number;
  occupancyPct: number | null;
  roomRevenue: number;
  /** Over the whole range: the nights' ADRs weighted by rooms sold. */
  adr: number | null;
};

/** The most nights one call may ask for (the function refuses more). */
export const BUSINESS_NUMBERS_MAX_NIGHTS = 401;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Throws with the database's message, which says what was wrong in plain words. */
export async function loadBusinessNumbers(
  ssr: SupabaseClient,
  hotelId: string,
  from: string,
  to: string,
): Promise<BusinessNight[]> {
  const { data, error } = await ssr.rpc("staff_hotel_business_numbers", { p_hotel_id: hotelId, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    stayDate: String(r.stay_date),
    roomsSold: num(r.rooms_sold) ?? 0,
    roomsAvailable: num(r.rooms_available) ?? 0,
    occupancyPct: num(r.occupancy_pct),
    roomRevenue: num(r.room_revenue) ?? 0,
    adr: num(r.adr),
  }));
}

/** The range in one line: rooms sold over rooms available, all revenue, ADR over rooms sold. */
export function businessTotals(nights: readonly BusinessNight[]): BusinessTotals {
  let sold = 0;
  let available = 0;
  let revenue = 0;
  let adrRevenue = 0;
  for (const n of nights) {
    sold += n.roomsSold;
    available += n.roomsAvailable;
    revenue += n.roomRevenue;
    if (n.adr !== null) adrRevenue += n.adr * n.roomsSold;
  }
  return {
    roomsSold: sold,
    roomsAvailable: available,
    occupancyPct: available > 0 ? Math.round((sold / available) * 1000) / 10 : null,
    roomRevenue: Math.round(revenue * 100) / 100,
    adr: sold > 0 ? Math.round((adrRevenue / sold) * 100) / 100 : null,
  };
}

/** The nights month by month (YYYY-MM, oldest first), each added up as businessTotals does. */
export function businessByMonth(nights: readonly BusinessNight[]): { month: string; totals: BusinessTotals }[] {
  const months = new Map<string, BusinessNight[]>();
  for (const n of nights) {
    const month = n.stayDate.slice(0, 7);
    const list = months.get(month);
    if (list) list.push(n);
    else months.set(month, [n]);
  }
  return [...months.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, list]) => ({ month, totals: businessTotals(list) }));
}
