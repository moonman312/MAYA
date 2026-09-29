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
import { computeGuardrailSuggestions } from "../../../../../../supabase/functions/_shared/onboarding/suggest";

type Row = Record<string, unknown>;
type Filter = ["eq", string, unknown] | ["in", string, unknown[]];

function fakeSupabase(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const failInsertFor = new Set<string>();
  /** Functions that answer with an error, the way Postgres refuses (save_rule's checks). */
  const failRpc = new Map<string, { code?: string; message: string }>();
  /** Columns that "do not exist yet" — an update naming one fails the way PostgREST does pre-migration. */
  const missingColumns = new Set<string>();
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
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
      then(resolve: (v: { data: unknown; error: { code?: string; message: string } | null }) => void) {
        return run().then(resolve);
      },
    };

    async function run(): Promise<{ data: unknown; error: { code?: string; message: string } | null }> {
      if (mode === "insert" && pendingInsert) {
        if (failInsertFor.has(table)) {
          return { data: null, error: { message: `insert into ${table} rejected` } };
        }
        const inserted = pendingInsert.map((r) => ({ id: r.id ?? `${table}-gen-${nextId++}`, ...r }));
        tableOf(table).push(...inserted);
        return { data: single ? (inserted[0] ?? null) : inserted, error: null };
      }
      if (mode === "update" && pendingUpdate) {
        const missing = Object.keys(pendingUpdate).find((k) => missingColumns.has(k));
        if (missing) {
          return {
            data: null,
            error: {
              code: "PGRST204",
              message: `Could not find the '${missing}' column of '${table}' in the schema cache`,
            },
          };
        }
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
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      // The room-type answer path checks rank explicitly now that it writes
      // on the service role; the tests are about the answer, not the door.
      if (name === "can_manage_hotel") return { data: true, error: null };
      const failure = failRpc.get(name);
      if (failure) return { data: null, error: failure };
      return { data: null, error: null };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, tables, failInsertFor, failRpc, missingColumns, rpcs };
}

const HOTEL = "hotel-1";
const RT1 = "0a000000-0000-4000-8000-000000000001";
const state = vi.hoisted(() => ({ client: null as unknown, hotelId: "hotel-1" }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
// The audit line goes through the service-role client; the fake doubles as it
// so the test can see the rpc land.
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => state.client,
  isAdminConfigured: () => true,
}));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => state.hotelId }));
// A live hotel is re-priced behind the response; mid-onboarding there is
// nothing to re-price. Recorded, never run.
const afterCalls = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterCalls.push(fn);
  },
}));
vi.mock("@/lib/engine", () => ({ evaluateHotel: vi.fn() }));
const nudgeHotelSync = vi.hoisted(() => vi.fn(async () => "nudged"));
// Skip's holds come from a dry run of the engine (rule-preview.test.ts);
// here there are no rows to mark.
vi.mock("@/lib/rule-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rule-preview")>()),
  skipPlanForRule: async () => ({ marks: [], holdNights: [] }),
}));
vi.mock("@/lib/pms/sync-nudge", () => ({ nudgeHotelSync }));

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

  it("tells someone below Revenue Manager why the card can't be answered, and changes nothing", async () => {
    // Row security leaves their claim an update of no rows, which used to
    // come back as "Finding was already resolved".
    const { client, tables } = seedClosedPeriodFinding();
    client.rpc = async (name: string) => ({ data: name === "can_manage_hotel" ? false : null, error: null });
    state.client = client;
    for (const action of ["confirm", "dismiss"]) {
      const res = await post({ action });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Only a Revenue Manager or above can answer this.");
    }
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "proposed" });
    expect(tables.get("hotel_closed_periods") ?? []).toHaveLength(0);
  });

  it("tells MAYA staff outside God Mode to turn it on, rather than which role they lack", async () => {
    const { client, tables } = seedClosedPeriodFinding();
    client.rpc = async (name: string) => ({
      data: name === "can_manage_hotel" ? false : name === "is_platform_admin" ? true : null,
      error: null,
    });
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("God Mode is off. Turn it on from the Command Center to change this property.");
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "proposed" });
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

  it("a rule the database refuses saves nothing, and leaves the finding retryable", async () => {
    const { client, tables, failRpc } = fakeSupabase({
      room_types: [{ id: RT1, hotel_id: HOTEL, is_active: true, counts_as_room: true }],
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
    // save_rule writes the rule, its condition and room types in one
    // transaction: a refusal leaves no rule half made.
    failRpc.set("save_rule", { code: "23514", message: "This property already has 40 active rules, which is the maximum." });
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This property already has 40 active rules, which is the maximum.");
    expect(tables.get("pricing_rules") ?? []).toHaveLength(0);
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "proposed" });
  });
});

describe("add_rule: an accepted suggestion", () => {
  it("saves the suggested rule through save_rule, on, with its undo box ticked and its own priority", async () => {
    const { client, rpcs } = fakeSupabase({
      room_types: [{ id: RT1, hotel_id: HOTEL, is_active: true, counts_as_room: true }],
      onboarding_findings: [
        {
          id: "f1",
          hotel_id: HOTEL,
          kind: "rule_suggestion",
          status: "proposed",
          payload: {
            suggestion_type: "add_rule",
            room_type_ids: [RT1],
            spec: {
              name: "Busy nights",
              priority: 100,
              condition: { occupancy_operator: "gt", occupancy_threshold: 0.8 },
              action: { action_type: "percent", action_direction: "increase", action_value: 10 },
              is_pickup_rule: false,
            },
          },
        },
      ],
    });
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(200);
    const save = rpcs.find((r) => r.name === "save_rule")!;
    // The first review has no popup: the confirm applies it.
    expect(save.args).toMatchObject({
      p_hotel_id: HOTEL,
      p_is_new: true,
      p_activation: "apply",
      p_fields: expect.objectContaining({
        name: "Busy nights",
        priority: 100,
        undo_on_cancellation: true,
        action_type: "percent",
        action_direction: "increase",
        action_value: 10,
        signal: [RT1],
        affected: [RT1],
      }),
    });
  });

  it("from the Rules tab's suggestions, saves the owner's Skip under the id the popup previewed", async () => {
    const { client, rpcs } = fakeSupabase({
      room_types: [{ id: RT1, hotel_id: HOTEL, is_active: true, counts_as_room: true }],
      onboarding_findings: [
        {
          id: "f1",
          hotel_id: HOTEL,
          kind: "rule_suggestion",
          status: "proposed",
          payload: {
            suggestion_type: "add_rule",
            room_type_ids: [RT1],
            spec: {
              name: "Busy nights",
              priority: 90,
              condition: { occupancy_operator: "gt", occupancy_threshold: 0.8 },
              action: { action_type: "fixed", action_direction: "increase", action_value: 12 },
              is_pickup_rule: false,
            },
          },
        },
      ],
    });
    state.client = client;
    const ruleId = "0d000000-0000-4000-8000-000000000001";
    // The days could not be worked out: Skip holds every day the rule could act on, with no check.
    const res = await post({ action: "confirm", activation: "skip", ruleId, touched: [], hold_all: true });
    expect(res.status).toBe(200);
    expect(rpcs.find((r) => r.name === "save_rule")!.args).toMatchObject({
      p_rule_id: ruleId,
      p_activation: "skip",
      p_fields: expect.objectContaining({ priority: 90, action_type: "fixed", action_value: 12 }),
    });
  });

  it("on the Rules tab's suggestions, a confirm without the owner's choice from the popup is refused, and the card stays", async () => {
    const { client, rpcs, tables } = fakeSupabase({
      room_types: [{ id: RT1, hotel_id: HOTEL, is_active: true, counts_as_room: true }],
      onboarding_states: [{ hotel_id: HOTEL, import_job_id: "job-refresh" }],
      import_jobs: [{ id: "job-refresh", hotel_id: HOTEL, stats: { mode: "refresh" } }],
      onboarding_findings: [
        {
          id: "f1",
          hotel_id: HOTEL,
          kind: "rule_suggestion",
          status: "proposed",
          payload: {
            suggestion_type: "add_rule",
            room_type_ids: [RT1],
            spec: {
              name: "Busy nights",
              priority: 100,
              condition: { occupancy_operator: "gt", occupancy_threshold: 0.8 },
              action: { action_type: "percent", action_direction: "increase", action_value: 10 },
              is_pickup_rule: false,
            },
          },
        },
      ],
    });
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "activation_required" });
    expect(rpcs.find((r) => r.name === "save_rule")).toBeUndefined();
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "proposed" });
  });

  it("keeps the days of a rule copied from the owner's weekend moves, and every day otherwise", async () => {
    const finding = (id: string, spec: Record<string, unknown>) => ({
      id,
      hotel_id: HOTEL,
      kind: "rule_suggestion",
      status: "proposed",
      payload: {
        suggestion_type: "add_rule",
        room_type_ids: [RT1],
        spec: {
          priority: 100,
          condition: { occupancy_operator: "gt", occupancy_threshold: 0.6 },
          action: { action_type: "percent", action_direction: "increase", action_value: 20 },
          is_pickup_rule: false,
          ...spec,
        },
      },
    });
    const roomTypes = [{ id: RT1, hotel_id: HOTEL, is_active: true, counts_as_room: true }];
    const weekend = fakeSupabase({
      room_types: roomTypes,
      onboarding_findings: [finding("f1", { name: "Filling-up raise (Fri and Sat)", dow_mask: 48 })],
    });
    state.client = weekend.client;
    expect((await post({ action: "confirm" })).status).toBe(200);
    expect(weekend.rpcs.find((r) => r.name === "save_rule")!.args).toMatchObject({
      p_fields: expect.objectContaining({ name: "Filling-up raise (Fri and Sat)", dow_mask: 48 }),
    });

    const bad = fakeSupabase({ room_types: roomTypes, onboarding_findings: [finding("f1", { name: "Odd days", dow_mask: 400 })] });
    state.client = bad.client;
    expect((await post({ action: "confirm" })).status).toBe(200);
    expect(bad.rpcs.find((r) => r.name === "save_rule")!.args).toMatchObject({
      p_fields: expect.objectContaining({ name: "Odd days", dow_mask: 127 }),
    });
  });
});

describe("remove_rule: delete vs turn-it-off", () => {
  function seedRemoveRuleFinding() {
    return fakeSupabase({
      onboarding_findings: [
        {
          id: "f1",
          hotel_id: HOTEL,
          kind: "rule_suggestion",
          status: "proposed",
          payload: { suggestion_type: "remove_rule", rule_id: "pk1", rule_name: "Old pickup spike" },
        },
      ],
      pricing_rules: [{ id: "pk1", hotel_id: HOTEL, name: "Old pickup spike", is_active: true }],
      pickup_event: [
        { id: "pe1", hotel_id: HOTEL, rule_id: "pk1", stay_date: "2026-08-01" },
        { id: "pe2", hotel_id: HOTEL, rule_id: "pk1", stay_date: "2026-08-02" },
      ],
    });
  }

  it("plain confirm deletes the rule and its pickup events", async () => {
    const { client, tables } = seedRemoveRuleFinding();
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(200);
    expect(tables.get("pricing_rules")).toHaveLength(0);
    expect(tables.get("pickup_event")).toHaveLength(0);
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "confirmed" });
  });

  it("confirm with keepRule pauses the rule and leaves its history intact", async () => {
    const { client, tables } = seedRemoveRuleFinding();
    state.client = client;
    const res = await post({ action: "confirm", keepRule: true });
    expect(res.status).toBe(200);
    expect(tables.get("pricing_rules")?.[0]).toMatchObject({ id: "pk1", is_active: false });
    expect(tables.get("pickup_event")).toHaveLength(2);
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "confirmed" });
  });
});

describe("suspect_room_type: the owner's answer is counts_as_room, not is_active", () => {
  function seedSuspect() {
    return fakeSupabase({
      onboarding_findings: [
        {
          id: "f1",
          hotel_id: HOTEL,
          kind: "suspect_room_type",
          status: "proposed",
          payload: { room_type_id: "rt-court", name: "Pickleball Court", reasons: [] },
        },
      ],
      room_types: [
        { id: "rt-court", hotel_id: HOTEL, name: "Pickleball Court", is_active: true, counts_as_room: null },
      ],
    });
  }

  const audits = (rpcs: { name: string; args: Record<string, unknown> }[]) =>
    rpcs.filter((r) => r.name === "platform_log_event");

  it("confirm marks it not-a-room, stamps who answered, leaves is_active alone, and audits before/after", async () => {
    const { client, tables, rpcs } = seedSuspect();
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(200);
    // is_active is the PMS's flag; excluding a court from the room count must
    // not also make it disappear from everything else.
    expect(tables.get("room_types")?.[0]).toMatchObject({
      counts_as_room: false,
      counts_as_room_set_by: "user-1",
      is_active: true,
    });
    expect(audits(rpcs)).toEqual([
      {
        name: "platform_log_event",
        args: {
          p_event_type: "room_type.classified",
          p_entity_type: "room_type",
          p_entity_id: "rt-court",
          p_hotel_id: HOTEL,
          p_detail: {
            room_type_id: "rt-court",
            name: "Pickleball Court",
            before: null,
            after: false,
            via: "onboarding_review",
            actor_user_id: "user-1",
          },
        },
      },
    ]);
    // Mid-onboarding (no live hotel row): nothing to re-price.
    expect(afterCalls).toHaveLength(0);
  });

  it("dismiss records that it IS a room, so the bill-time heuristic stops excluding it", async () => {
    const { client, tables, rpcs } = seedSuspect();
    state.client = client;
    const res = await post({ action: "dismiss" });
    expect(res.status).toBe(200);
    expect(tables.get("room_types")?.[0]).toMatchObject({ counts_as_room: true, is_active: true });
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "dismissed" });
    expect(audits(rpcs)[0]?.args.p_detail).toMatchObject({ before: null, after: true, via: "onboarding_review" });
  });

  it("asks a live hotel's (refresh mode) scheduled sync to price it again", async () => {
    const { client, tables } = seedSuspect();
    tables.set("hotels", [{ id: HOTEL, is_active: true }]);
    state.client = client;
    nudgeHotelSync.mockClear();
    expect((await post({ action: "confirm" })).status).toBe(200);
    expect(nudgeHotelSync).toHaveBeenCalledTimes(1);
  });

  it("404s, logs nothing and leaves the finding retryable when the type is gone", async () => {
    const { client, tables, rpcs } = seedSuspect();
    tables.set("room_types", []);
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(404);
    expect(audits(rpcs)).toEqual([]);
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "proposed" });
  });

  it("403s below Revenue Manager without touching the type", async () => {
    const { client, tables } = seedSuspect();
    client.rpc = async (name: string) => ({ data: name === "can_manage_hotel" ? false : null, error: null });
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(403);
    expect(tables.get("room_types")?.[0]).toMatchObject({ counts_as_room: null });
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "proposed" });
  });

  it("ahead of the migration, confirm falls back to is_active = false and does not 500", async () => {
    // Deploy order must not matter: the code can be live before the column is.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, tables, missingColumns } = seedSuspect();
    missingColumns.add("counts_as_room");
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(200);
    expect(tables.get("room_types")?.[0]).toMatchObject({ is_active: false, counts_as_room: null });
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "confirmed" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("ahead of the migration, dismiss is the no-op it always was, and does not 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, tables, missingColumns } = seedSuspect();
    missingColumns.add("counts_as_room");
    state.client = client;
    const res = await post({ action: "dismiss" });
    expect(res.status).toBe(200);
    expect(tables.get("room_types")?.[0]).toMatchObject({ is_active: true, counts_as_room: null });
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "dismissed" });
    warn.mockRestore();
  });
});

describe("guardrail_suggestion: accepting sets the number on the room type", () => {
  function seedDataFloor() {
    // The card exactly as a refresh files it for an unset floor with no
    // strategy answer: the number came from the room type's own rates.
    const [floor] = computeGuardrailSuggestions(
      [
        {
          room_type_id: "rt-king",
          name: "Deluxe King",
          floor_price: 1,
          ceiling_price: 99999.99,
          observed_p99_rate: 400,
          observed_median_rate: 220,
          row_count: 500,
        },
      ],
      { floor: null, ceiling: null },
    );
    expect(floor).toMatchObject({ field: "floor_price", suggested: 90 });
    return fakeSupabase({
      onboarding_findings: [
        { id: "f1", hotel_id: HOTEL, kind: "guardrail_suggestion", status: "proposed", payload: floor },
      ],
      room_types: [{ id: "rt-king", hotel_id: HOTEL, floor_price: 1, ceiling_price: 99999.99 }],
    });
  }

  it("confirm applies the suggested floor", async () => {
    const { client, tables } = seedDataFloor();
    state.client = client;
    const res = await post({ action: "confirm" });
    expect(res.status).toBe(200);
    expect(tables.get("room_types")?.[0]).toMatchObject({ floor_price: 90, ceiling_price: 99999.99 });
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "confirmed" });
  });

  it("confirm with the owner's own number applies theirs instead", async () => {
    const { client, tables } = seedDataFloor();
    state.client = client;
    const res = await post({ action: "confirm", value: 75 });
    expect(res.status).toBe(200);
    expect(tables.get("room_types")?.[0]).toMatchObject({ floor_price: 75 });
  });

  it("dismiss leaves the room type alone", async () => {
    const { client, tables } = seedDataFloor();
    state.client = client;
    const res = await post({ action: "dismiss" });
    expect(res.status).toBe(200);
    expect(tables.get("room_types")?.[0]).toMatchObject({ floor_price: 1 });
    expect(tables.get("onboarding_findings")?.[0]).toMatchObject({ status: "dismissed" });
  });
});
