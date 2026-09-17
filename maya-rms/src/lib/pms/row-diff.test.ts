/**
 * The skip is only safe if "same fingerprint" truly means "nothing differed" —
 * a false match here silently withholds a real change from the database, which
 * no later sync would notice.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase as sharedFake } from "../engine/fake-supabase.test";
import {
  dropUnchangedReservationRows,
  fingerprintDigest,
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
    in: (_c: string, ids: unknown[]) => {
      const page = {
        order: () => page,
        range: async (from: number, to: number) =>
        failRead
          ? { data: null, error: { message: "read exploded" } }
          : {
              data: stored
                .filter((r) => ids.includes(r.external_reservation_id))
                .slice(from, to + 1),
              error: null,
            },
      };
      return page;
    },
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

describe("fingerprint digest", () => {
  it("finds exactly the changed set a full string comparison finds, on random rows", async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const stored: ReservationWriteRow[] = [];
    const incoming: ReservationWriteRow[] = [];
    for (let i = 0; i < 3000; i++) {
      const base = row({
        external_reservation_id: `R${i % 400}`,
        stay_date: `2026-08-${String(1 + (i % 28)).padStart(2, "0")}`,
        current_rate: Math.round(rnd() * 30000) / 100,
        booking_window_days: Math.floor(rnd() * 90),
        raw_payload: { status: rnd() < 0.5 ? "confirmed" : "checked_in", guest: { n: Math.floor(rnd() * 5) }, note: "x".repeat(Math.floor(rnd() * 40)) },
      });
      stored.push(base);
      const roll = rnd();
      incoming.push(
        roll < 0.6
          ? { ...base, raw_payload: JSON.parse(JSON.stringify(base.raw_payload)) }
          : roll < 0.7
            ? { ...base, current_rate: (base.current_rate ?? 0) + 0.01 }
            : roll < 0.8
              ? { ...base, raw_payload: { ...(base.raw_payload as object), note: "changed" } }
              : roll < 0.9
                ? { ...base, room_type_id: null }
                : { ...base, stay_date: "2026-09-30" },
      );
    }
    // Dedupe on the unique key, as every caller does before diffing.
    const byKey = new Map(stored.map((r) => [`${r.external_reservation_id}:${r.stay_date}`, r]));
    const truth = new Map([...byKey].map(([k, r]) => [k, reservationRowFingerprint(r)]));
    const inc = [...new Map(incoming.map((r) => [`${r.external_reservation_id}:${r.stay_date}`, r])).values()];
    const expected = inc.filter((r) => truth.get(`${r.external_reservation_id}:${r.stay_date}`) !== reservationRowFingerprint(r));
    const res = await dropUnchangedReservationRows(fakeSupabase([...byKey.values()]), "hotel-1", inc);
    expect(res.rows).toEqual(expected);
    expect(expected.length).toBeGreaterThan(100);
    expect(res.unchanged).toBeGreaterThan(100);
  });

  it("is 16 hex characters and separates near misses", () => {
    expect(fingerprintDigest("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintDigest("abc|1")).not.toBe(fingerprintDigest("abc|2"));
  });
});

describe("reading back a large chunk", () => {
  it("pages 1,500 stored nights of one chunk in the unique key's order and misses none", async () => {
    const stored: ReservationWriteRow[] = [];
    for (let i = 0; i < 1500; i++) {
      stored.push(row({ external_reservation_id: `R${i % 150}`, stay_date: `2027-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + ((i / 12) | 0) % 28).padStart(2, "0")}` }));
    }
    const unique = [...new Map(stored.map((r) => [`${r.external_reservation_id}:${r.stay_date}`, r])).values()];
    // Stored in an order that is not the key order, as a heap table would be.
    const shuffled = [...unique].sort((a, b) => (a.current_rate! * 7 + a.stay_date.charCodeAt(9)) % 11 - (b.current_rate! * 7 + b.stay_date.charCodeAt(9)) % 11 || b.stay_date.localeCompare(a.stay_date));
    const orders: string[] = [];
    const { client } = sharedFake({ reservations: shuffled.map((r) => ({ ...r })) }, { maxRows: 1000 });
    const realFrom = client.from.bind(client);
    (client as unknown as { from: unknown }).from = (t: string) => {
      const b = realFrom(t) as unknown as { order: (col: string, o?: unknown) => unknown };
      const realOrder = b.order;
      b.order = (col: string, o?: unknown) => (orders.push(col), realOrder(col, o));
      return b;
    };
    const incoming = unique.map((r, i) => (i % 10 === 0 ? { ...r, current_rate: 1 } : r));
    const res = await dropUnchangedReservationRows(client, "hotel-1", incoming);
    expect(res.error).toBeNull();
    expect(res.rows.length).toBe(Math.ceil(unique.length / 10));
    expect(res.unchanged).toBe(unique.length - res.rows.length);
    expect(orders.slice(0, 2)).toEqual(["external_reservation_id", "stay_date"]);
  });
});
