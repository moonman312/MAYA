import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Drops reservation rows whose stored copy already matches, so a sync only
 * writes what actually changed.
 *
 * The upserts used to rewrite every fetched row every tick. The database
 * swallows that, but everything downstream of a write does not: each one is
 * WAL, a realtime message to any dashboard subscribed to `reservations`, and a
 * dead tuple for vacuum — multiplied by the whole book on every full sweep,
 * per hotel, forever. Reading the rows back first costs one query per chunk
 * and turns "rewrite the book" into "touch the handful that moved".
 *
 * The fingerprint covers every column the sync writes, raw_payload included —
 * nothing reads the payload back today, but a skipped write must mean "nothing
 * differed", not "nothing we happened to compare differed".
 */

export type ReservationWriteRow = {
  hotel_id: string;
  external_reservation_id: string;
  room_type_id: string | null;
  stay_date: string;
  booking_date: string | null;
  booking_window_days: number | null;
  current_rate: number | null;
  raw_payload: unknown;
};

const READ_IN_CHUNK = 200;
const READ_PAGE = 1000;

/** JSON with keys sorted at every depth, so identical objects always collide. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function reservationRowFingerprint(row: {
  room_type_id: string | null;
  booking_date: string | null;
  booking_window_days: number | null;
  current_rate: number | null;
  raw_payload: unknown;
}): string {
  return [
    row.room_type_id ?? "",
    row.booking_date ?? "",
    row.booking_window_days ?? "",
    row.current_rate ?? "",
    stableStringify(row.raw_payload ?? null),
  ].join("|");
}

export async function dropUnchangedReservationRows(
  supabase: SupabaseClient,
  hotelId: string,
  rows: ReservationWriteRow[],
): Promise<{ rows: ReservationWriteRow[]; unchanged: number; error: { message: string } | null }> {
  if (rows.length === 0) return { rows, unchanged: 0, error: null };

  const extIds = [...new Set(rows.map((r) => r.external_reservation_id))];
  const stored = new Map<string, string>();
  for (let i = 0; i < extIds.length; i += READ_IN_CHUNK) {
    const chunk = extIds.slice(i, i + READ_IN_CHUNK);
    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await supabase
        .from("reservations")
        .select(
          "external_reservation_id, stay_date, room_type_id, booking_date, booking_window_days, current_rate, raw_payload",
        )
        .eq("hotel_id", hotelId)
        .in("external_reservation_id", chunk)
        .range(from, from + READ_PAGE - 1);
      // Failing open — writing every row — is exactly what happened before this
      // existed, so a broken read degrades to yesterday's behavior, not data loss.
      if (error) return { rows, unchanged: 0, error };
      for (const r of data ?? []) {
        stored.set(
          `${r.external_reservation_id}:${r.stay_date}`,
          reservationRowFingerprint({
            room_type_id: r.room_type_id == null ? null : String(r.room_type_id),
            booking_date: r.booking_date == null ? null : String(r.booking_date),
            booking_window_days: r.booking_window_days == null ? null : Number(r.booking_window_days),
            current_rate: r.current_rate == null ? null : Number(r.current_rate),
            raw_payload: r.raw_payload,
          }),
        );
      }
      if ((data ?? []).length < READ_PAGE) break;
    }
  }

  const changed = rows.filter(
    (r) => stored.get(`${r.external_reservation_id}:${r.stay_date}`) !== reservationRowFingerprint(r),
  );
  return { rows: changed, unchanged: rows.length - changed.length, error: null };
}
