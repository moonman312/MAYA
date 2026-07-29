/**
 * Regression tests for the confirm/dismiss finding route's idempotency.
 *
 * An adversarial review found the route applied side effects (insert a
 * pricing rule, insert a closed period, deactivate a room type) before ever
 * checking the finding's own status — so a retry, a double-click past the
 * UI's busy guard, or two open tabs on the same finding re-ran the side
 * effect and duplicated it. These tests pin the fix: the finding is claimed
 * via a conditional status update BEFORE any side effect runs, a second
 * attempt on an already-resolved finding is rejected outright, and a side
 * effect that fails puts the status back so a genuine retry still works.
 *
 * A minimal in-memory fake stands in for Supabase; next/headers and the
 * hotel/session helpers are mocked so the route runs outside a request
 * context.
 */
import { describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter = ["eq", string, unknown] | ["in", string, unknown[]];

function fakeSupabase(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const failInsertFor = new Set<string>();
  let nextId = 0;
  const tableOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every(([kind, col, val]) =>
      kind === "eq" ? row[col] === val : (val as unknown[]).includes(row[col]),
    );
  }

  function builder(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let pendingInsert: Row[] | null = null;
    let pendingUpdate: Row | null = null;
    let single = false;

    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push(["eq", col, val]);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push(["in", col, vals]);
        return api;
      },
      insert(payload: Row | Row[]) {
        pendingInsert = Array.isArray(payload) ? payload : [payload];
        mode = "insert";
        return api;
      },
      update(patch: Row) {
        pendingUpdate = patch;
        mode = "update";
        return api;
      },
      delete() {
        mode = "delete";
        return api;
      },
      maybeSingle() {
        single = true;
        return run();
      },
      single() {
        single = true;
        return run();
      },
      then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
        return run().then(resolve);
      },
    };

    async function run(): Promise<{ data: unknown; error: { message: string } | null }> {
      if (mode === "insert" && pendingInsert) {
        if (failInsertFor.has(table)) {
          return { data: null, error: { message: `insert into ${table} rejected` } };
        }
        const inserted = pendingInsert.map((r) => ({ id: r.id ?? `${table}-gen-${nextId++}`, ...r }));
        tableOf(table).push(...inserted);
        return { data: single ? (inserted[0] ?? null) : inserted, error: null };
      }
      if (mode === "update" && pendingUpdate) {
        const rows = tableOf(table).filter((r) => matches(r, filters));
        for (const r of rows) Object.assign(r, pendingUpdate);
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (mode === "delete") {
        const kept = tableOf(table).filter((r) => !matches(r, filters));
        tables.set(table, kept);
        return { data: null, error: null };
      }
      const rows = tableOf(table).filter((r) => matches(r, filters));
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }

    return api;
  }

  const client = {
    from: (t: string) => builder(t),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, tables, failInsertFor };
}

const HOTEL = "hotel-1";
const state = vi.hoisted(() => ({ client: null as unknown, hotelId: "hotel-1" }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => state.hotelId }));

const { POST } = await import("./route");

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/onboarding/findings/f1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ findingId: "f1" }) },
  );
}

function seedClosedPeriodFinding(status = "proposed") {
  return fakeSupabase({
    onboarding_findings: [
      {
        id: "f1",
        hotel_id: HOTEL,
        kind: "closed_period",
        status,
        payload: { start_date: "2025-01-01", end_date: "2025-01-10" },
      },
    ],
  });
}

describe("findings confirm route: claims before side effects", () => {
  it("confirms once: finding moves to confirmed and inserts exactly one closed period", async () => {
    const { client, tables } = seedClosedPeriodFinding();
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(200);
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "confirmed" });
    expect(tables.get("hotel_closed_periods")).toHaveLength(1);
  });

  it("rejects a second confirm on the same finding and does not duplicate the closed period", async () => {
    const { client, tables } = seedClosedPeriodFinding();
    state.client = client;
    await post({ action: "confirm" });
    const second = await post({ action: "confirm" });
    expect(second.status).toBe(409);
    expect(tables.get("hotel_closed_periods")).toHaveLength(1);
  });

  it("rejects confirming a finding that was already dismissed", async () => {
    const { client, tables } = seedClosedPeriodFinding("dismissed");
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(409);
    expect(tables.get("hotel_closed_periods") ?? []).toHaveLength(0);
  });

  it("reverts the claim when the side effect fails, leaving the finding retryable", async () => {
    const { client, tables, failInsertFor } = seedClosedPeriodFinding();
    failInsertFor.add("hotel_closed_periods");
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(500);
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "proposed" });
    expect(tables.get("hotel_closed_periods") ?? []).toHaveLength(0);
  });

  it("cleans up the orphaned pricing rule when the condition insert fails, and leaves the finding retryable", async () => {
    const { client, tables, failInsertFor } = fakeSupabase({
      onboarding_findings: [
        {
          id: "f1",
          hotel_id: HOTEL,
          kind: "rule_suggestion",
          status: "proposed",
          payload: {
            suggestion_type: "add_rule",
            room_type_ids: [],
            spec: {
              name: "Slow-date rescue",
              priority: 1,
              condition: { occupancy_operator: "gt", occupancy_threshold: 0.5 },
              action: { action_type: "percent", action_direction: "decrease", action_value: 15 },
              is_pickup_rule: true,
            },
          },
        },
      ],
    });
    failInsertFor.add("rule_condition");
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(500);
    expect(tables.get("pricing_rules") ?? []).toHaveLength(0);
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "proposed" });
  });
});
