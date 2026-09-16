/**
 * The guard that keeps a connected-but-unpaid property from being touched.
 *
 * The failure this exists to prevent: a Marketplace arrival is parked at
 * 'pending' with no subscription row, the entitlement check waves it through
 * because a missing row means "no opinion", and the scheduler reads its
 * bookings before anyone has paid or agreed to anything.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { splitByParked } from "../../../supabase/functions/_shared/pms/parked";

type Row = { hotel_id: string; status: string; pms_type: string };

/** Enough of PostgREST's builder for the one query the module makes. */
function fake(rows: Row[], error?: { message: string }) {
  const seen: { pmsType?: string; ids?: string[] } = {};
  const client = {
    from: () => {
      const api = {
        select: () => api,
        eq: (_c: string, v: string) => {
          seen.pmsType = v;
          return api;
        },
        in: (_c: string, v: string[]) => {
          seen.ids = v;
          return Promise.resolve(
            error ? { data: null, error } : { data: rows.filter((r) => v.includes(r.hotel_id)), error: null },
          );
        },
      };
      return api;
    },
  } as unknown as SupabaseClient;
  return { client, seen };
}

const conn = (hotel_id: string, status: string): Row => ({ hotel_id, status, pms_type: "cloudbeds" });

describe("splitByParked", () => {
  it("leaves a pending Marketplace property completely alone", async () => {
    const { client } = fake([conn("paid", "connected"), conn("parked", "pending")]);
    const r = await splitByParked(client, "cloudbeds", ["paid", "parked"]);
    expect(r.allowed).toEqual(["paid"]);
    expect(r.parked).toEqual([{ hotelId: "parked", status: "pending" }]);
  });

  it("lets every working state through, including the ones worth retrying", async () => {
    const rows = ["connected", "degraded", "error"].map((s, i) => conn(`h${i}`, s));
    const { client } = fake(rows);
    const r = await splitByParked(client, "cloudbeds", ["h0", "h1", "h2"]);
    expect(r.allowed).toEqual(["h0", "h1", "h2"]);
    expect(r.parked).toEqual([]);
  });

  it("does nothing for a hotel whose connection row has gone", async () => {
    const { client } = fake([]);
    const r = await splitByParked(client, "cloudbeds", ["ghost"]);
    expect(r.allowed).toEqual([]);
    expect(r.parked).toEqual([{ hotelId: "ghost", status: "missing" }]);
  });

  it("fails CLOSED on a read error, unlike the entitlement check", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fake([], { message: "timeout" });
    const r = await splitByParked(client, "cloudbeds", ["a", "b"]);
    expect(r.allowed).toEqual([]);
    expect(r.parked.map((p) => p.hotelId)).toEqual(["a", "b"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("scopes the lookup to the PMS doing the asking", async () => {
    const { client, seen } = fake([conn("h", "connected")]);
    await splitByParked(client, "mews", ["h"]);
    expect(seen.pmsType).toBe("mews");
    expect(seen.ids).toEqual(["h"]);
  });

  it("asks nothing of the database for an empty batch", async () => {
    const { client, seen } = fake([]);
    const r = await splitByParked(client, "cloudbeds", []);
    expect(r).toEqual({ allowed: [], parked: [] });
    expect(seen.ids).toBeUndefined();
  });
});
