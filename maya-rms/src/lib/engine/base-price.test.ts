/**
 * Regression: the engine must never treat its own published price as a base.
 *
 * The original bug drove a real runaway — a stay date whose last reservation
 * cancelled kept having its still-active effects applied to a number that
 * already contained them, once per five-minute run, until it hit the floor or
 * the ceiling and was pushed to the PMS at every step.
 */
import { describe, expect, it } from "vitest";
import { flushPublishedPrices, publishDecision, type PublishRow } from "./pricing";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = {
  hotel_id: string;
  stay_date: string;
  room_type_id: string;
  price: number;
  base_price: number | null;
  computed_at: string;
};

/** Minimal stand-in for the published_price table. */
function fakeSupabase(seed: Row[] = []) {
  const rows = [...seed];
  const client = {
    from() {
      return {
        upsert(payloads: Partial<Row>[]) {
          for (const payload of payloads) {
            const idx = rows.findIndex(
              (r) =>
                r.hotel_id === payload.hotel_id &&
                r.stay_date === payload.stay_date &&
                r.room_type_id === payload.room_type_id,
            );
            if (idx === -1) {
              rows.push({ base_price: null, ...payload } as Row);
            } else {
              rows[idx] = { ...rows[idx], ...payload };
            }
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any as SupabaseClient, rows };
}

const HOTEL = "h1";
const DATE = "2026-08-14";
const RT = "rt1";

function decideAndFlush(
  client: SupabaseClient,
  rows: Row[],
  finalPrice: number,
  computedAt: string,
  basePrice: number,
) {
  const current = rows.find(
    (r) => r.hotel_id === HOTEL && r.stay_date === DATE && r.room_type_id === RT,
  );
  const decision = publishDecision(current, finalPrice, basePrice);
  const toWrite: PublishRow[] = decision.write
    ? [
        {
          payload: {
            hotel_id: HOTEL,
            stay_date: DATE,
            room_type_id: RT,
            price: finalPrice,
            base_price: basePrice,
            computed_at: computedAt,
          },
          priceMoved: decision.priceMoved,
        },
      ]
    : [];
  return flushPublishedPrices(client, toWrite);
}

describe("the publish flow remembers the base price", () => {
  it("stores the base alongside the published price", async () => {
    const { client, rows } = fakeSupabase();
    const published = await decideAndFlush(client, rows, 110, "t0", 100);
    expect(published).toBe(1);
    expect(rows[0].price).toBe(110);
    expect(rows[0].base_price).toBe(100);
  });

  it("records a base even when the price itself did not move", async () => {
    // A quiet cell must still get its base written — those are precisely the
    // cells that later lose their last reservation.
    const { client, rows } = fakeSupabase([
      { hotel_id: HOTEL, stay_date: DATE, room_type_id: RT, price: 110, base_price: null, computed_at: "t0" },
    ]);
    const published = await decideAndFlush(client, rows, 110, "t1", 100);
    expect(rows[0].base_price).toBe(100);
    // ...but a base-only correction is not a rate change.
    expect(published).toBe(0);
  });

  it("does no work when both the price and the base are already correct", async () => {
    const { client, rows } = fakeSupabase([
      { hotel_id: HOTEL, stay_date: DATE, room_type_id: RT, price: 110, base_price: 100, computed_at: "t0" },
    ]);
    const published = await decideAndFlush(client, rows, 110, "t1", 100);
    expect(published).toBe(0);
    expect(rows[0].computed_at).toBe("t0");
  });

  it("keeps the base stable across repeated runs, so effects cannot compound", async () => {
    const { client, rows } = fakeSupabase();
    // Same base, same active +10% effect, ten consecutive runs.
    for (let i = 0; i < 10; i++) {
      await decideAndFlush(client, rows, 110, `t${i}`, 100);
    }
    expect(rows[0].base_price).toBe(100);
    expect(rows[0].price).toBe(110);
  });
});
