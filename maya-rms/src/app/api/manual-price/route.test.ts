/**
 * The manual price route. A typed number is a reset point for the cell: the
 * rows land with the setter's id, whatever was already applying on those
 * nights is suppressed (ladder) or retired (pickup), the engine re-prices,
 * and the sync function is nudged when it's worth nudging. Clearing stamps
 * cleared_at, lifts the ladder suppression, and leaves retired pickups alone.
 *
 * A minimal in-memory fake stands in for Supabase (the range filters the
 * route leans on — gte/lte/is/not/in — are the part that matters); the
 * engine, the limiter and fetch are mocked so nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter =
  | ["eq", string, unknown]
  | ["in", string, unknown[]]
  | ["gte", string, string]
  | ["lte", string, string]
  | ["is", string, null]
  | ["notNull", string];

function fakeSupabase(
  seed: Record<string, Row[]> = {},
  // A table that answers every call with this error — the not-yet-migrated case.
  broken: Record<string, { code: string; message: string }> = {},
) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const tableOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      const v = row[f[1]];
      if (f[0] === "eq") return v === f[2];
      if (f[0] === "in") return f[2].includes(v);
      if (f[0] === "gte") return String(v) >= f[2];
      if (f[0] === "lte") return String(v) <= f[2];
      if (f[0] === "is") return v == null;
      return v != null;
    });
  }

  function builder(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "update" | "upsert" = "select";
    let patch: Row | null = null;
    let pending: Row[] | null = null;
    let conflictKeys: string[] = [];
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
      gte(col: string, val: string) {
        filters.push(["gte", col, val]);
        return api;
      },
      lte(col: string, val: string) {
        filters.push(["lte", col, val]);
        return api;
      },
      is(col: string, val: null) {
        filters.push(["is", col, val]);
        return api;
      },
      not(col: string) {
        filters.push(["notNull", col]);
        return api;
      },
      order() {
        return api;
      },
      update(next: Row) {
        mode = "update";
        patch = next;
        return api;
      },
      upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
        mode = "upsert";
        pending = Array.isArray(payload) ? payload : [payload];
        conflictKeys = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        return api;
      },
      maybeSingle() {
        single = true;
        return run();
      },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        return run().then(resolve, reject);
      },
    };

    async function run() {
      if (broken[table]) return { data: null, error: broken[table] };
      if (mode === "upsert" && pending) {
        const rows = tableOf(table);
        for (const incoming of pending) {
          const existing = rows.find((r) => conflictKeys.every((k) => r[k] === incoming[k]));
          if (existing) Object.assign(existing, incoming);
          else rows.push({ ...incoming });
        }
        return { data: pending, error: null };
      }
      if (mode === "update" && patch) {
        const rows = tableOf(table).filter((r) => matches(r, filters));
        for (const r of rows) Object.assign(r, patch);
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      const rows = tableOf(table).filter((r) => matches(r, filters));
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }

    return api;
  }

  return { from: (t: string) => builder(t), tables };
}

const USER = "11111111-1111-4111-8111-111111111111";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const OTHER_ROOM = "44444444-4444-4444-8444-444444444444";
const RULE_A = "55555555-5555-4555-8555-555555555555";
const RULE_B = "66666666-6666-4666-8666-666666666666";

// Fixed clock so "today" is stable: 2026-09-15 in the hotel's zone.
const NOW = new Date("2026-09-15T18:00:00Z");
const TODAY = "2026-09-15";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  canManage: true,
  throttled: false,
  fake: null as unknown,
}));
const evaluateHotel = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
// `after` needs a request scope; here the nudge just runs inline.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void fn(),
}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
    rpc: async () => ({ data: state.canManage, error: null }),
    from: (t: string) => (state.fake as ReturnType<typeof fakeSupabase>).from(t),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => state.fake,
}));
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    enforceRateLimit: async (_name: string, _subject: string, message?: string) =>
      state.throttled
        ? NextResponse.json({ error: message }, { status: 429, headers: { "Retry-After": "60" } })
        : null,
  };
});
vi.mock("@/lib/engine", () => ({ evaluateHotel }));

const { POST, DELETE, GET } = await import("./route");

function seed(
  overrides: Record<string, Row[]> = {},
  broken: Record<string, { code: string; message: string }> = {},
) {
  return fakeSupabase(
    {
    hotels: [{ id: HOTEL, timezone: "America/New_York", currency: "USD" }],
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
    pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected" }],
    room_types: [
      { id: ROOM, hotel_id: HOTEL, floor_price: 100, ceiling_price: 400 },
      { id: OTHER_ROOM, hotel_id: HOTEL, floor_price: 100, ceiling_price: 400 },
    ],
    pricing_rules: [
      { id: RULE_A, hotel_id: HOTEL },
      { id: RULE_B, hotel_id: HOTEL },
    ],
    ladder_rule_state: [],
    pickup_event: [],
    manual_price: [],
    ...overrides,
    },
    broken,
  );
}

function request(method: string, body: unknown) {
  return new Request("http://localhost/api/manual-price", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD = { hotelId: HOTEL, roomTypeId: ROOM, dateFrom: "2026-09-20", price: 250 };

function post(body: unknown = GOOD) {
  return POST(request("POST", body));
}
function del(body: unknown) {
  return DELETE(request("DELETE", body));
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  state.userId = USER;
  state.canManage = true;
  state.throttled = false;
  state.fake = seed();
  evaluateHotel.mockReset();
  evaluateHotel.mockResolvedValue({ run_id: "run-1" });
  fetchSpy = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
  vi.stubEnv("CLOUDBEDS_CRON_SECRET", "shh");
  vi.stubEnv("MAYA_EVAL_HORIZON_DAYS", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function tables() {
  return (state.fake as ReturnType<typeof fakeSupabase>).tables;
}

describe("POST /api/manual-price — doors", () => {
  it("401 when signed out, and nothing written", async () => {
    state.userId = null;
    expect((await post()).status).toBe(401);
    expect(tables().get("manual_price")).toEqual([]);
  });

  it("403 below Revenue Manager, naming the rank", async () => {
    state.canManage = false;
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Revenue Manager access or higher/);
    expect(evaluateHotel).not.toHaveBeenCalled();
  });

  it("429 when the caller's budget is spent", async () => {
    state.throttled = true;
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("POST /api/manual-price — validation", () => {
  const cases: [string, unknown, RegExp][] = [
    ["a hotel id that is not a uuid", { ...GOOD, hotelId: "nope" }, /property/],
    ["a room type id that is not a uuid", { ...GOOD, roomTypeId: "nope" }, /room type/],
    ["a start date that is not a date", { ...GOOD, dateFrom: "2026-02-30" }, /Start date/],
    ["an end date that is not a date", { ...GOOD, dateTo: "tomorrow" }, /End date/],
    ["an end date before the start", { ...GOOD, dateTo: "2026-09-19" }, /before the start/],
    ["a span over 366 nights", { ...GOOD, dateTo: "2027-09-21" }, /366 nights/],
    ["a start date before the hotel's today", { ...GOOD, dateFrom: "2026-09-14" }, /tonight onwards/],
    ["a missing price", { ...GOOD, price: undefined }, /number of zero or more/],
    ["a non-numeric price", { ...GOOD, price: "lots" }, /number of zero or more/],
    ["a negative price", { ...GOOD, price: -1 }, /number of zero or more/],
    ["a price below the floor, naming it", { ...GOOD, price: 99 }, /floor of \$100\.00/],
    ["a price above the ceiling, naming it", { ...GOOD, price: 401 }, /ceiling of \$400\.00/],
    ["a price numeric(10,2) cannot hold", { ...GOOD, price: 1e9 }, /more than MAYA can store/],
    ["a note over 500 characters", { ...GOOD, note: "x".repeat(501) }, /under 500 characters/],
    // today + 364 = 2027-09-14 is the last night the engine ever prices.
    ["a night more than a year out", { ...GOOD, dateFrom: "2027-09-15" }, /up to a year ahead/],
    ["a span ending more than a year out", { ...GOOD, dateFrom: "2027-09-10", dateTo: "2027-09-15" }, /up to a year ahead/],
    [
      "a room type from another property",
      { ...GOOD, roomTypeId: "77777777-7777-4777-8777-777777777777" },
      /isn't on this property/,
    ],
  ];

  for (const [label, body, message] of cases) {
    it(`400 for ${label}`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(message);
      expect(tables().get("manual_price")).toEqual([]);
      expect(evaluateHotel).not.toHaveBeenCalled();
    });
  }

  it("accepts the last night inside the year", async () => {
    expect((await post({ ...GOOD, dateFrom: "2027-09-14" })).status).toBe(200);
  });

  it("rounds to cents before the floor check, so the row holds what the preview shows", async () => {
    const res = await post({ ...GOOD, price: 123.456 });
    expect(res.status).toBe(200);
    expect((await res.json()).preview[0]).toMatchObject({ base: 123.46, final: 123.46 });
    expect(tables().get("manual_price")![0].price).toBe(123.46);
    // 99.996 rounds to 100.00: on the floor, not under it.
    expect((await post({ ...GOOD, price: 99.996 })).status).toBe(200);
  });

  it("accepts a stay starting on the hotel's local today even when UTC has moved on", async () => {
    // 23:30 in New York on the 15th is already the 16th in UTC.
    vi.setSystemTime(new Date("2026-09-16T03:30:00Z"));
    const res = await post({ ...GOOD, dateFrom: TODAY });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/manual-price — the save", () => {
  it("writes one row per night with the setter stamped, and previews each", async () => {
    const res = await post({ ...GOOD, dateFrom: "2026-09-20", dateTo: "2026-09-22", note: " weekend " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, cells: 3, suppressedRules: 0, retiredPickups: 0 });
    expect(body.preview).toEqual([
      { stay_date: "2026-09-20", base: 250, final: 250, clamped_by: "none" },
      { stay_date: "2026-09-21", base: 250, final: 250, clamped_by: "none" },
      { stay_date: "2026-09-22", base: 250, final: 250, clamped_by: "none" },
    ]);

    const rows = tables().get("manual_price")!;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({
        hotel_id: HOTEL,
        room_type_id: ROOM,
        price: 250,
        note: "weekend",
        set_by: USER,
        set_at: NOW.toISOString(),
        cleared_at: null,
        cleared_by: null,
      });
    }
    expect(rows.map((r) => r.stay_date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
  });

  it("re-opens a cleared row rather than leaving a second one behind", async () => {
    state.fake = seed({
      manual_price: [
        {
          hotel_id: HOTEL,
          room_type_id: ROOM,
          stay_date: "2026-09-20",
          price: 180,
          set_by: "someone-else",
          cleared_at: "2026-09-01T00:00:00Z",
          cleared_by: "someone-else",
        },
      ],
    });
    expect((await post()).status).toBe(200);
    const rows = tables().get("manual_price")!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ price: 250, set_by: USER, cleared_at: null, cleared_by: null });
  });

  it("suppresses active ladder rows and retires open pickup events on those cells only, once", async () => {
    state.fake = seed({
      ladder_rule_state: [
        // Two live ones on the range: both get suppressed.
        { rule_id: RULE_A, stay_date: "2026-09-20", room_type_id: ROOM, is_active: true, suppressed_at: null },
        { rule_id: RULE_B, stay_date: "2026-09-21", room_type_id: ROOM, is_active: true, suppressed_at: null },
        // Already suppressed by an earlier override: not counted again.
        { rule_id: RULE_A, stay_date: "2026-09-21", room_type_id: ROOM, is_active: true, suppressed_at: "2026-09-10T00:00:00Z" },
        // Inactive, other room, outside the range: untouched.
        { rule_id: RULE_A, stay_date: "2026-09-20", room_type_id: ROOM, is_active: false, suppressed_at: null },
        { rule_id: RULE_A, stay_date: "2026-09-20", room_type_id: OTHER_ROOM, is_active: true, suppressed_at: null },
        { rule_id: RULE_A, stay_date: "2026-09-23", room_type_id: ROOM, is_active: true, suppressed_at: null },
      ],
      pickup_event: [
        { id: "pe-1", hotel_id: HOTEL, stay_date: "2026-09-20", affected_room_type_id: ROOM, retired_at: null },
        { id: "pe-2", hotel_id: HOTEL, stay_date: "2026-09-20", affected_room_type_id: ROOM, retired_at: "2026-09-01T00:00:00Z" },
        { id: "pe-3", hotel_id: HOTEL, stay_date: "2026-09-20", affected_room_type_id: OTHER_ROOM, retired_at: null },
        { id: "pe-4", hotel_id: "other-hotel", stay_date: "2026-09-20", affected_room_type_id: ROOM, retired_at: null },
      ],
    });

    const res = await post({ ...GOOD, dateFrom: "2026-09-20", dateTo: "2026-09-22" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suppressedRules: 2, retiredPickups: 1 });

    const ladder = tables().get("ladder_rule_state")!;
    const stamped = ladder.filter((r) => r.suppressed_at === NOW.toISOString());
    expect(stamped).toHaveLength(2);
    // Suppressed, not deactivated: the rule must not re-fire on the same trigger.
    expect(stamped.every((r) => r.is_active === true)).toBe(true);
    expect(ladder[2].suppressed_at).toBe("2026-09-10T00:00:00Z");
    expect(ladder.slice(3).every((r) => r.suppressed_at == null)).toBe(true);

    const pickups = tables().get("pickup_event")!;
    expect(pickups[0].retired_at).toBe(NOW.toISOString());
    expect(pickups[1].retired_at).toBe("2026-09-01T00:00:00Z");
    expect(pickups[2].retired_at).toBeNull();
    expect(pickups[3].retired_at).toBeNull();
  });

  it("re-prices the hotel on the admin client, only as far as the change reaches", async () => {
    await post({ ...GOOD, dateFrom: "2026-09-20", dateTo: "2026-09-24" });
    expect(evaluateHotel).toHaveBeenCalledTimes(1);
    const [client, hotelId, evalTs, horizon] = evaluateHotel.mock.calls[0];
    expect(client).toBe(state.fake);
    expect(hotelId).toBe(HOTEL);
    // The run's snapshot lands at set_at: bookings taken before the price
    // was typed are then inside the pickup baseline, not counted as pickup.
    expect(evalTs).toBe(NOW.toISOString());
    expect(tables().get("manual_price")![0].set_at).toBe(evalTs);
    // 15th through 24th inclusive.
    expect(horizon).toBe(10);
  });

  it("a failed evaluation does not fail the save", async () => {
    evaluateHotel.mockRejectedValueOnce(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post();
    expect(res.status).toBe(200);
    expect(tables().get("manual_price")).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("POST /api/manual-price — pushed", () => {
  it("nudges the sync function with the secret when the hotel is live and in window", async () => {
    const res = await post();
    expect((await res.json()).pushed).toBe("nudged");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/cloudbeds-scheduled-sync");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-cloudbeds-cron-secret"]).toBe("shh");
    expect(JSON.parse(String(init.body))).toEqual({ hotel_id: HOTEL });
  });

  it("next_cycle without the secret — no call goes out", async () => {
    vi.stubEnv("CLOUDBEDS_CRON_SECRET", "");
    const res = await post();
    expect((await res.json()).pushed).toBe("next_cycle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("nudges the hotel's own PMS function with that function's secret", async () => {
    vi.stubEnv("THINK_CRON_SECRET", "think-shh");
    state.fake = seed({
      pms_connections: [
        // A stale connection to another PMS does not decide it.
        { hotel_id: HOTEL, pms_type: "cloudbeds", status: "disconnected" },
        { hotel_id: HOTEL, pms_type: "think", status: "connected" },
      ],
    });
    expect((await (await post()).json()).pushed).toBe("nudged");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/think-scheduled-sync");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-think-cron-secret"]).toBe("think-shh");
    expect(headers["x-cloudbeds-cron-secret"]).toBeUndefined();
  });

  it("next_cycle for a hotel with no connection, or a PMS with no nudge", async () => {
    state.fake = seed({ pms_connections: [] });
    expect((await (await post()).json()).pushed).toBe("next_cycle");
    state.fake = seed({ pms_connections: [{ hotel_id: HOTEL, pms_type: "opera", status: "connected" }] });
    expect((await (await post()).json()).pushed).toBe("next_cycle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("simulation while the hotel is still simulating, and when it has no settings row", async () => {
    state.fake = seed({ hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] });
    expect((await (await post()).json()).pushed).toBe("simulation");

    state.fake = seed({ hotel_settings: [] });
    expect((await (await post()).json()).pushed).toBe("simulation");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("beyond_window only when every night is past the push horizon", async () => {
    // today + 59 = 2026-11-13 is the last night the push covers.
    const inside = await (await post({ ...GOOD, dateFrom: "2026-11-13" })).json();
    expect(inside).toMatchObject({ pushed: "nudged", pushWindow: { now: 1, later: 0, days: 60 } });
    const beyond = await (await post({ ...GOOD, dateFrom: "2026-11-14" })).json();
    expect(beyond).toMatchObject({ pushed: "beyond_window", pushWindow: { now: 0, later: 1, days: 60 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the same window as the scheduled push when MAYA_EVAL_HORIZON_DAYS moves it", async () => {
    vi.stubEnv("MAYA_EVAL_HORIZON_DAYS", "30");
    // today + 29 = 2026-10-14 is now the last pushed night.
    const inside = await (await post({ ...GOOD, dateFrom: "2026-10-14" })).json();
    expect(inside).toMatchObject({ pushed: "nudged", pushWindow: { now: 1, later: 0, days: 30 } });
    const beyond = await (await post({ ...GOOD, dateFrom: "2026-10-15" })).json();
    expect(beyond).toMatchObject({ pushed: "beyond_window", pushWindow: { now: 0, later: 1, days: 30 } });
  });

  it("counts a range wholly inside the window as all now", async () => {
    const body = await (await post({ ...GOOD, dateFrom: "2026-09-20", dateTo: "2026-09-24" })).json();
    expect(body).toMatchObject({ pushed: "nudged", cells: 5, pushWindow: { now: 5, later: 0 } });
  });

  it("counts a range wholly beyond the window as all later, with no nudge", async () => {
    const body = await (await post({ ...GOOD, dateFrom: "2026-12-01", dateTo: "2026-12-05" })).json();
    expect(body).toMatchObject({ pushed: "beyond_window", cells: 5, pushWindow: { now: 0, later: 5 } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("splits a straddling range per night and still nudges for the near ones", async () => {
    // 11-12 and 11-13 are inside; 11-14 and 11-15 are past the horizon.
    const body = await (await post({ ...GOOD, dateFrom: "2026-11-12", dateTo: "2026-11-15" })).json();
    expect(body).toMatchObject({ pushed: "nudged", cells: 4, pushWindow: { now: 2, later: 2 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Every night is still stored: the split is about the push, not the save.
    expect(tables().get("manual_price")).toHaveLength(4);
  });

  it("keeps the simulation verdict for a straddling range, and still reports the split", async () => {
    state.fake = seed({ hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] });
    const body = await (await post({ ...GOOD, dateFrom: "2026-11-12", dateTo: "2026-11-15" })).json();
    expect(body).toMatchObject({ pushed: "simulation", pushWindow: { now: 2, later: 2 } });
  });

  it("a rejected nudge is swallowed", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).pushed).toBe("nudged");
  });
});

describe("POST /api/manual-price — before the table exists", () => {
  // PostgREST reports an unknown table from its schema cache (PGRST205) — the
  // shape the client actually sees; Postgres's own 42P01 is the other one.
  it.each([
    { code: "PGRST205", message: "Could not find the table 'public.manual_price' in the schema cache" },
    { code: "42P01", message: 'relation "manual_price" does not exist' },
  ])("503 with a plain sentence, not 500, and says so in the log ($code)", async (fault) => {
    state.fake = seed({}, { manual_price: fault });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "This needs a database update first." });
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("manual_price_v1");
    // Nothing downstream ran: no rules paused, no re-price, no nudge.
    expect(tables().get("ladder_rule_state")).toEqual([]);
    expect(evaluateHotel).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("other database faults still read as a generic 500", async () => {
    state.fake = seed({}, { manual_price: { code: "XX000", message: "disk on fire" } });
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain("disk");
  });
});

describe("DELETE /api/manual-price", () => {
  function seedOverridden() {
    return seed({
      manual_price: [
        { hotel_id: HOTEL, room_type_id: ROOM, stay_date: "2026-09-20", price: 250, set_by: USER, cleared_at: null, cleared_by: null },
        { hotel_id: HOTEL, room_type_id: ROOM, stay_date: "2026-09-21", price: 250, set_by: USER, cleared_at: null, cleared_by: null },
        // Already cleared: not counted, not re-stamped.
        { hotel_id: HOTEL, room_type_id: ROOM, stay_date: "2026-09-22", price: 250, set_by: USER, cleared_at: "2026-09-10T00:00:00Z", cleared_by: "x" },
        // Other room: untouched.
        { hotel_id: HOTEL, room_type_id: OTHER_ROOM, stay_date: "2026-09-20", price: 250, set_by: USER, cleared_at: null, cleared_by: null },
      ],
      ladder_rule_state: [
        { rule_id: RULE_A, stay_date: "2026-09-20", room_type_id: ROOM, is_active: true, suppressed_at: "2026-09-10T00:00:00Z" },
        { rule_id: RULE_A, stay_date: "2026-09-20", room_type_id: OTHER_ROOM, is_active: true, suppressed_at: "2026-09-10T00:00:00Z" },
      ],
      pickup_event: [
        { id: "pe-1", hotel_id: HOTEL, stay_date: "2026-09-20", affected_room_type_id: ROOM, retired_at: "2026-09-10T00:00:00Z" },
      ],
    });
  }

  it("401 / 403 / 400 doors match POST", async () => {
    state.userId = null;
    expect((await del({ hotelId: HOTEL, roomTypeId: ROOM, dateFrom: "2026-09-20" })).status).toBe(401);
    state.userId = USER;
    state.canManage = false;
    expect((await del({ hotelId: HOTEL, roomTypeId: ROOM, dateFrom: "2026-09-20" })).status).toBe(403);
    state.canManage = true;
    expect((await del({ hotelId: HOTEL, roomTypeId: ROOM, dateFrom: "nope" })).status).toBe(400);
  });

  it("clears open rows in range, lifts ladder suppression, leaves retired pickups retired", async () => {
    state.fake = seedOverridden();
    const res = await del({ hotelId: HOTEL, roomTypeId: ROOM, dateFrom: "2026-09-20", dateTo: "2026-09-22" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cells: 2 });

    const rows = tables().get("manual_price")!;
    expect(rows[0]).toMatchObject({ cleared_at: NOW.toISOString(), cleared_by: USER });
    expect(rows[1]).toMatchObject({ cleared_at: NOW.toISOString(), cleared_by: USER });
    expect(rows[2]).toMatchObject({ cleared_at: "2026-09-10T00:00:00Z", cleared_by: "x" });
    expect(rows[3].cleared_at).toBeNull();

    const ladder = tables().get("ladder_rule_state")!;
    expect(ladder[0].suppressed_at).toBeNull();
    expect(ladder[0].is_active).toBe(true);
    expect(ladder[1].suppressed_at).toBe("2026-09-10T00:00:00Z");

    expect(tables().get("pickup_event")![0].retired_at).toBe("2026-09-10T00:00:00Z");

    // MAYA's own price comes back and goes out the same way a save does.
    expect(evaluateHotel).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults the end date to the start date", async () => {
    state.fake = seedOverridden();
    const res = await del({ hotelId: HOTEL, roomTypeId: ROOM, dateFrom: "2026-09-20" });
    expect(await res.json()).toEqual({ ok: true, cells: 1 });
  });
});

describe("GET /api/manual-price", () => {
  function get(query: string) {
    return GET(new Request(`http://localhost/api/manual-price?${query}`));
  }

  it("401 when signed out", async () => {
    state.userId = null;
    expect((await get(`hotelId=${HOTEL}&from=2026-09-01&to=2026-09-30`)).status).toBe(401);
  });

  it("400 for a bad hotel id or dates", async () => {
    expect((await get(`hotelId=nope&from=2026-09-01&to=2026-09-30`)).status).toBe(400);
    expect((await get(`hotelId=${HOTEL}&from=2026-09-01`)).status).toBe(400);
    expect((await get(`hotelId=${HOTEL}&from=2026-09-30&to=2026-09-01`)).status).toBe(400);
  });

  it("lists open overrides in the window, in the contract's shape", async () => {
    state.fake = seed({
      manual_price: [
        { hotel_id: HOTEL, room_type_id: ROOM, stay_date: "2026-09-20", price: "250.00", set_at: "2026-09-15T18:00:00Z", set_by: USER, cleared_at: null },
        { hotel_id: HOTEL, room_type_id: ROOM, stay_date: "2026-09-21", price: "250.00", set_at: "2026-09-15T18:00:00Z", set_by: USER, cleared_at: "2026-09-16T00:00:00Z" },
        { hotel_id: HOTEL, room_type_id: ROOM, stay_date: "2026-10-05", price: "300.00", set_at: "2026-09-15T18:00:00Z", set_by: USER, cleared_at: null },
      ],
    });
    const res = await get(`hotelId=${HOTEL}&from=2026-09-01&to=2026-09-30`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      overrides: [
        { stay_date: "2026-09-20", room_type_id: ROOM, price: 250, set_at: "2026-09-15T18:00:00Z", set_by: USER },
      ],
    });
  });
});
