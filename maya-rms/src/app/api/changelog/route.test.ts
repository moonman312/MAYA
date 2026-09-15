/**
 * Regression tests for the changelog route's failure behavior.
 *
 * An adversarial review found that any Supabase failure — a transient
 * PostgREST error, an unresolvable hotel — answered with the fabricated
 * demo changelog and HTTP 200, so a hotelier auditing what the system did
 * could be shown ten fully narrated price changes that never happened.
 * These tests pin the fix: a failed audit read is an error response with no
 * cycles in the body, a missing hotel is a 400, and the demo changelog is
 * reserved for installs with no Supabase configured at all.
 *
 * A minimal in-memory fake stands in for Supabase; next/headers and the
 * hotel/session helpers are mocked so the route runs outside a request
 * context.
 */
import { describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

function fakeSupabase(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const failSelectFor = new Map<string, { message: string; code?: string }>();
  const tableOf = (name: string) => tables.get(name) ?? [];

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let single = false;

    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push([col, vals]);
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      maybeSingle() {
        single = true;
        return run();
      },
      then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
        return run().then(resolve);
      },
    };

    async function run(): Promise<{ data: unknown; error: { message: string } | null }> {
      const failure = failSelectFor.get(table);
      if (failure) return { data: null, error: failure };
      const rows = tableOf(table).filter((r) =>
        filters.every(([col, val]) => (Array.isArray(val) ? val.includes(r[col]) : r[col] === val)),
      );
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }

    return api;
  }

  const client = {
    from: (t: string) => builder(t),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, failSelectFor };
}

const HOTEL = "hotel-1";
const state = vi.hoisted(() => ({
  client: null as unknown,
  hotelId: "hotel-1" as string | null,
  configured: true,
  // The service-role client, when SUPABASE_SERVICE_ROLE_KEY is set.
  admin: null as unknown,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({
  isSupabaseConfigured: () => state.configured,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => state.admin != null,
  createAdminClient: () => state.admin,
}));
vi.mock("@/lib/hotel-context", () => ({
  resolveAccessibleHotelId: async () => state.hotelId,
}));

const { GET } = await import("./route");

function seedHealthyHotel() {
  return fakeSupabase({
    evaluation_audit: [
      {
        hotel_id: HOTEL,
        evaluation_run_id: "run-1",
        stay_date: "2026-08-01",
        room_type_id: "rt-1",
        evaluated_at: "2026-07-29T08:00:00Z",
        base_price: 180,
        final_price: 198,
        pre_clamp_price: 198,
        floor_price: 100,
        ceiling_price: 400,
        details: {
          application_order: ["rule:rule-1"],
          matched_ladder_rules: [
            {
              rule_id: "rule-1",
              action: { kind: "percent", direction: "increase", value: 10 },
              metrics: { occupancy: 0.82 },
            },
          ],
        },
      },
    ],
    hotels: [{ id: HOTEL, currency: "USD" }],
    room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Garden King" }],
    pricing_rules: [
      {
        id: "rule-1",
        hotel_id: HOTEL,
        name: "Busy week bump",
        action_type: "percent",
        action_direction: "increase",
        action_value: 10,
        is_pickup_rule: false,
        rule_condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 },
      },
    ],
    evaluation_run_log: [
      { hotel_id: HOTEL, evaluation_run_id: "run-1", evaluated_at: "2026-07-29T08:00:00Z" },
    ],
  });
}

describe("changelog route: failures are errors, never demo data", () => {
  it("returns an error response when the audit read fails, with no cycles in the body", async () => {
    const { client, failSelectFor } = seedHealthyHotel();
    failSelectFor.set("evaluation_audit", { message: "connection reset by peer" });
    state.client = client;
    state.hotelId = HOTEL;
    state.configured = true;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({
      error: "Something went wrong on our side. Try again in a moment.",
    });
    expect(Array.isArray(body)).toBe(false);
  });

  it("maps an RLS rejection on the audit read to a 403, not demo data", async () => {
    const { client, failSelectFor } = seedHealthyHotel();
    failSelectFor.set("evaluation_audit", {
      message: "permission denied for table evaluation_audit",
      code: "42501",
    });
    state.client = client;
    state.hotelId = HOTEL;
    state.configured = true;

    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You need manager access to do that." });
  });

  it("returns 400 when no hotel resolves for a signed-in user", async () => {
    const { client } = seedHealthyHotel();
    state.client = client;
    state.hotelId = null;
    state.configured = true;

    const res = await GET();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No hotel" });
  });

  it("builds cycles from real audit rows when the database is healthy", async () => {
    const { client } = seedHealthyHotel();
    state.client = client;
    state.hotelId = HOTEL;
    state.configured = true;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ has_changes: true, timestamp: "2026-07-29T08:00:00Z" });
    expect(body[0].changes[0]).toMatchObject({
      room_type: "Garden King",
      rule_name: "Busy week bump",
      original_rate: 180,
      new_rate: 198,
      change_pct: 10,
      evaluation_run_id: "run-1",
    });
  });

  // profiles is self-select only under RLS, so the caller's client would name
  // nobody but the caller. The names come off the service role instead.
  it("names a teammate who typed a manual price, via the service role", async () => {
    const manualRow = {
      hotel_id: HOTEL,
      evaluation_run_id: "run-2",
      stay_date: "2026-08-02",
      room_type_id: "rt-1",
      evaluated_at: "2026-07-30T08:00:00Z",
      base_price: 180,
      final_price: 180,
      pre_clamp_price: 180,
      floor_price: 100,
      ceiling_price: 400,
      details: {
        application_order: [],
        base_source: "manual",
        manual_override: { set_by: "user-2", set_at: "2026-07-30T07:59:00Z" },
      },
    };
    const withManual = fakeSupabase({
      evaluation_audit: [manualRow],
      hotels: [{ id: HOTEL, currency: "USD" }],
      room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Garden King" }],
      pricing_rules: [],
      evaluation_run_log: [
        { hotel_id: HOTEL, evaluation_run_id: "run-2", evaluated_at: "2026-07-30T08:00:00Z" },
      ],
      // What the caller's own client can see of profiles: themselves only.
      profiles: [{ id: "user-1", full_name: "Corey" }],
    });
    state.client = withManual.client;
    state.hotelId = HOTEL;
    state.configured = true;
    state.admin = fakeSupabase({
      profiles: [
        { id: "user-1", full_name: "Corey" },
        { id: "user-2", full_name: "Jake" },
      ],
    }).client;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body[0].changes[0].description).toBe("Jake set the base rate to $180.00.");

    // Without a service role the lookup stays on the caller's client, and a
    // teammate's price falls back to the anonymous line rather than failing.
    state.admin = null;
    const fallback = await (await GET()).json();
    expect(fallback[0].changes[0].description).toBe("A manager set the base rate to $180.00.");
  });

  it("still serves the demo changelog when Supabase is not configured", async () => {
    state.configured = false;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(10);
  });
});
