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
import { hotelsImportingNow, splitByParked } from "../../../supabase/functions/_shared/pms/parked";
import { callTouchesColumn, fakeSupabase, missingColumn, type FakeFault, type FakeRow } from "../engine/fake-supabase.test";

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

/**
 * A never-paid property the retention sweep emptied is held until its fresh
 * import has completed. claim_pms_sync_batch holds it on the batch path, but a
 * manual price save asks for one hotel's sync by id and skips the claim, so
 * the same hold has to live here.
 */
describe("splitByParked for a purged property", () => {
  const PURGED_AT = "2027-03-01T00:00:00.000Z";

  function world(opts: { jobs?: FakeRow[]; purgedAt?: string | null; fault?: FakeFault } = {}) {
    return fakeSupabase(
      {
        pms_connections: [
          { hotel_id: "purged", pms_type: "cloudbeds", status: "connected" },
          { hotel_id: "normal", pms_type: "cloudbeds", status: "connected" },
        ],
        hotels: [
          { id: "purged", data_purged_at: opts.purgedAt === undefined ? PURGED_AT : opts.purgedAt },
          { id: "normal", data_purged_at: null },
        ],
        import_jobs: opts.jobs ?? [],
      },
      { fault: opts.fault },
    );
  }

  const job = (status: string, created_at: string): FakeRow => ({ id: `j-${created_at}`, hotel_id: "purged", status, created_at });

  it("holds it while no import created after the purge has completed", async () => {
    const db = world({
      jobs: [job("completed", "2026-09-01T00:00:00.000Z"), job("running", "2027-03-02T00:00:00.000Z")],
    });
    const r = await splitByParked(db.client, "cloudbeds", ["purged", "normal"]);
    expect(r.allowed).toEqual(["normal"]);
    expect(r.parked).toEqual([{ hotelId: "purged", status: "purged_importing" }]);
  });

  it("holds the single-hotel sync a manual price asks for too", async () => {
    const db = world();
    const r = await splitByParked(db.client, "cloudbeds", ["purged"]);
    expect(r.allowed).toEqual([]);
    expect(r.parked).toEqual([{ hotelId: "purged", status: "purged_importing" }]);
  });

  it("lets it through once the fresh import has completed", async () => {
    const db = world({ jobs: [job("completed", "2027-03-02T00:00:00.000Z")] });
    const r = await splitByParked(db.client, "cloudbeds", ["purged", "normal"]);
    expect(r.allowed).toEqual(["purged", "normal"]);
  });

  it("treats a missing column as nothing purged", async () => {
    const fault: FakeFault = (call) =>
      call.table === "hotels" && callTouchesColumn(call, "data_purged_at") ? missingColumn("hotels", "data_purged_at") : null;
    const db = world({ fault });
    const r = await splitByParked(db.client, "cloudbeds", ["purged", "normal"]);
    expect(r.allowed).toEqual(["purged", "normal"]);
  });

  it.each([
    ["hotels", { message: "timeout" }],
    ["import_jobs", { message: "timeout" }],
  ])("fails the whole batch closed when %s cannot be read", async (table, error) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = world({ fault: (call) => (call.table === table ? error : null) });
    const r = await splitByParked(db.client, "cloudbeds", ["purged", "normal"]);
    expect(r.allowed).toEqual([]);
    expect(r.parked.map((p) => p.status)).toEqual(["unknown", "unknown"]);
    spy.mockRestore();
  });
});

describe("hotelsImportingNow", () => {
  const NOW = "2026-09-16T12:00:00.000Z";
  const jobs: FakeRow[] = [
    { hotel_id: "h-running", status: "running", phase: "sync_current", lease_expires_at: "2026-09-16T12:02:00.000Z" },
    // Reading old years for hours: nothing keeps its current bookings fresh
    // but the scheduled sync, so it must not be skipped.
    { hotel_id: "h-history", status: "running", phase: "historical", lease_expires_at: "2026-09-16T12:02:00.000Z" },
    { hotel_id: "h-analyze", status: "running", phase: "analyze", lease_expires_at: "2026-09-16T12:02:00.000Z" },
    // Its worker died: the lease ran out, nobody is calling the PMS for it.
    { hotel_id: "h-expired", status: "running", phase: "sync_current", lease_expires_at: "2026-09-16T11:00:00.000Z" },
    { hotel_id: "h-queued", status: "queued", lease_expires_at: null },
    { hotel_id: "h-done", status: "completed", lease_expires_at: "2026-09-16T12:02:00.000Z" },
    { hotel_id: "h-elsewhere", status: "running", phase: "sync_current", lease_expires_at: "2026-09-16T12:02:00.000Z" },
  ];

  it("names only hotels in the batch refreshing the current window under a live lease", async () => {
    const { client } = fakeSupabase({ import_jobs: jobs });
    const got = await hotelsImportingNow(
      client,
      ["h-running", "h-history", "h-analyze", "h-expired", "h-queued", "h-done", "h-idle"],
      NOW,
    );
    expect([...got]).toEqual(["h-running"]);
  });

  it("fails open, so a read error never stops a tick from syncing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase({ import_jobs: jobs }, { fault: () => ({ message: "timeout" }) });
    expect((await hotelsImportingNow(client, ["h-running"], NOW)).size).toBe(0);
    err.mockRestore();
  });
});
