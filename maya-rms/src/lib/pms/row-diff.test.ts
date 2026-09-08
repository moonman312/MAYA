/**
 * The skip is only safe if "same fingerprint" truly means "nothing differed" —
 * a false match here silently withholds a real change from the database, which
 * no later sync would notice.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dropUnchangedReservationRows,
  reservationRowFingerprint,
  stableStringify,
  type ReservationWriteRow,
} from "./row-diff";

function row(o: Partial<ReservationWriteRow> = {}): ReservationWriteRow {
  return {
    hotel_id: "hotel-1",
    external_reservation_id: "R1",
    room_type_id: "rt-1",
    stay_date: "2026-08-15",
    booking_date: "2026-07-01",
    booking_window_days: 45,
    current_rate: 200,
    raw_payload: { status: "confirmed", rooms: ["101"] },
    ...o,
  };
}

/** Serves `stored` to the read-back; records nothing else. */
function fakeSupabase(stored: ReservationWriteRow[], failRead = false) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: (_c: string, ids: unknown[]) => ({
      range: async (from: number, to: number) =>
        failRead
          ? { data: null, error: { message: "read exploded" } }
          : {
              data: stored
                .filter((r) => ids.includes(r.external_reservation_id))
                .slice(from, to + 1),
              error: null,
            },
    }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe("stableStringify", () => {
  it("collides identical objects regardless of key order", () => {
    expect(stableStringify({ a: 1, b: { d: 2, c: [3] } })).toBe(
      stableStringify({ b: { c: [3], d: 2 }, a: 1 }),
    );
  });

  it("separates objects that genuinely differ", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe("dropUnchangedReservationRows", () => {
  it("drops a row whose stored copy matches exactly", async () => {
    const r = row();
    const res = await dropUnchangedReservationRows(fakeSupabase([r]), "hotel-1", [row()]);
    expect(res.rows).toEqual([]);
    expect(res.unchanged).toBe(1);
  });

  it.each([
    ["current_rate", { current_rate: 210 }],
    ["room_type_id", { room_type_id: "rt-2" }],
    ["booking_date", { booking_date: "2026-07-02" }],
    ["booking_window_days", { booking_window_days: 44 }],
    ["raw_payload", { raw_payload: { status: "checked_in", rooms: ["101"] } }],
  ] as const)("keeps a row whose %s changed", async (_field, change) => {
    const res = await dropUnchangedReservationRows(fakeSupabase([row()]), "hotel-1", [
      row(change),
    ]);
    expect(res.rows).toHaveLength(1);
    expect(res.unchanged).toBe(0);
  });

  it("keeps a brand-new night the store has never seen", async () => {
    const res = await dropUnchangedReservationRows(fakeSupabase([row()]), "hotel-1", [
      row({ stay_date: "2026-08-16" }),
    ]);
    expect(res.rows).toHaveLength(1);
  });

  it("does not confuse null with a value", () => {
    expect(reservationRowFingerprint(row({ current_rate: null }))).not.toBe(
      reservationRowFingerprint(row({ current_rate: 0 })),
    );
    expect(reservationRowFingerprint(row({ room_type_id: null }))).not.toBe(
      reservationRowFingerprint(row()),
    );
  });

  it("fails open: a broken read-back writes everything, like before it existed", async () => {
    const res = await dropUnchangedReservationRows(fakeSupabase([row()], true), "hotel-1", [
      row(),
    ]);
    expect(res.error).not.toBeNull();
    expect(res.rows).toHaveLength(1);
  });
});
