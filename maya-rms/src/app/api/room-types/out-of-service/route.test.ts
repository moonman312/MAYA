/**
 * Rooms out of service: add a block, list the open ones, clear one. Every
 * write is gated on rank, bounded by the room type's own count, logged, and
 * followed by a re-price. On a database without the table yet the routes say
 * "needs a database update" — never a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

function fakeSupabase(
  seed: Record<string, Row[]> = {},
  opts: { missingTables?: string[]; missingTableShape?: "pg" | "postgrest" } = {},
) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const rpcs: { name: string; args: Row }[] = [];
  const tableOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "update" | "insert" = "select";
    let patch: Row | null = null;
    let pending: Row[] = [];
    let single = false;

    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      is(col: string) {
        filters.push((r) => r[col] == null);
        return api;
      },
      lte(col: string, val: string) {
        filters.push((r) => String(r[col]) <= val);
        return api;
      },
      gte(col: string, val: string) {
        filters.push((r) => String(r[col]) >= val);
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
      insert(payload: Row | Row[]) {
        mode = "insert";
        pending = Array.isArray(payload) ? payload : [payload];
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
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        return run().then(resolve, reject);
      },
    };

    async function run() {
      if (opts.missingTables?.includes(table)) {
        // PostgREST answers from its schema cache (PGRST205) — that is what the
        // client actually sees; Postgres's own 42P01 is kept as the other shape.
        return opts.missingTableShape === "pg"
          ? { data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } }
          : {
              data: null,
              error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` },
            };
      }
      if (mode === "insert") {
        const rows = tableOf(table);
        const made = pending.map((p, i) => ({
          id: `aaaaaaa${rows.length + i}-0000-4000-8000-000000000000`,
          created_at: "2026-09-16T00:00:00Z",
          cleared_at: null,
          ...p,
        }));
        rows.push(...made);
        return { data: single ? made[0] : made, error: null };
      }
      const rows = tableOf(table).filter((r) => filters.every((f) => f(r)));
      if (mode === "update" && patch) for (const r of rows) Object.assign(r, patch);
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }

    return api;
  }

  return {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Row) => {
      rpcs.push({ name, args });
      if (name === "can_manage_hotel") return { data: state.canManage, error: null };
      return { data: null, error: null };
    },
    tables,
    rpcs,
  };
}

const USER = "11111111-1111-4111-8111-111111111111";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const BLOCK = "55555555-5555-4555-8555-555555555555";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  canManage: true,
  throttled: false,
  fake: null as unknown,
}));
const evaluateHotel = vi.hoisted(() => vi.fn());
const afterCalls = vi.hoisted(() => [] as Array<() => unknown>);

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterCalls.push(fn);
  },
}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
    rpc: (name: string, args: Row) => (state.fake as ReturnType<typeof fakeSupabase>).rpc(name, args),
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
      state.throttled ? NextResponse.json({ error: message }, { status: 429 }) : null,
  };
});
vi.mock("@/lib/engine", () => ({ evaluateHotel }));

const { GET, POST, DELETE } = await import("./route");

function seed(opts?: Parameters<typeof fakeSupabase>[1]) {
  return fakeSupabase(
    {
      room_types: [
        { id: ROOM, hotel_id: HOTEL, name: "Standard", display_name: null, total_rooms: 20 },
      ],
      room_type_out_of_service: [
        {
          id: BLOCK,
          hotel_id: HOTEL,
          room_type_id: ROOM,
          start_date: "2026-10-01",
          end_date: "2026-10-14",
          units: 4,
          reason: "Repaint",
          created_at: "2026-09-01T00:00:00Z",
          cleared_at: null,
        },
      ],
    },
    opts,
  );
}

function request(method: string, body: unknown) {
  return new Request("http://localhost/api/room-types/out-of-service", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const post = (body: unknown) => POST(request("POST", body));
const del = (body: unknown) => DELETE(request("DELETE", body));
const get = (q = `?hotelId=${HOTEL}`) => GET(new Request(`http://localhost/api/room-types/out-of-service${q}`));
async function flushAfter() {
  const fns = afterCalls.splice(0);
  for (const fn of fns) await fn();
}
const fake = () => state.fake as ReturnType<typeof fakeSupabase>;

const GOOD = { hotelId: HOTEL, roomTypeId: ROOM, startDate: "2026-11-01", endDate: "2026-11-10", units: 3 };

beforeEach(() => {
  state.userId = USER;
  state.canManage = true;
  state.throttled = false;
  state.fake = seed();
  evaluateHotel.mockReset();
  evaluateHotel.mockResolvedValue({ run_id: "run-1" });
  afterCalls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST — doors", () => {
  it("401 signed out, 403 below Revenue Manager, 429 over budget", async () => {
    state.userId = null;
    expect((await post(GOOD)).status).toBe(401);
    state.userId = USER;
    state.canManage = false;
    const res = await post(GOOD);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Revenue Manager access or higher/);
    state.canManage = true;
    state.throttled = true;
    expect((await post(GOOD)).status).toBe(429);
    expect(fake().tables.get("room_type_out_of_service")).toHaveLength(1);
  });
});

describe("POST — validation", () => {
  const cases: [string, unknown, RegExp][] = [
    ["a hotel id that is not a uuid", { ...GOOD, hotelId: "x" }, /property/],
    ["a room type id that is not a uuid", { ...GOOD, roomTypeId: "x" }, /room type/],
    ["a start date that is not a date", { ...GOOD, startDate: "2026-02-30" }, /Start date/],
    ["a missing end date", { ...GOOD, endDate: undefined }, /End date/],
    ["an end before the start", { ...GOOD, endDate: "2026-10-31" }, /before the start/],
    ["a span over 366 nights", { ...GOOD, endDate: "2027-11-02" }, /366 nights/],
    ["zero units", { ...GOOD, units: 0 }, /at least 1/],
    ["fractional units", { ...GOOD, units: 1.5 }, /whole number/],
    ["a missing unit count", { ...GOOD, units: undefined }, /whole number/],
    ["more units than the type has, naming the bound", { ...GOOD, units: 21 }, /Standard has 20 rooms/],
    ["a reason over 200 characters", { ...GOOD, reason: "x".repeat(201) }, /under 200 characters/],
    ["a room type from another property", { ...GOOD, roomTypeId: "77777777-7777-4777-8777-777777777777" }, /isn't on this property/],
  ];
  for (const [label, body, message] of cases) {
    it(`400 for ${label}`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(message);
      expect(fake().tables.get("room_type_out_of_service")).toHaveLength(1);
      expect(fake().rpcs.filter((r) => r.name === "platform_log_event")).toEqual([]);
    });
  }

  it("accepts units typed as a string, and exactly the type's whole count", async () => {
    expect((await post({ ...GOOD, units: "20" })).status).toBe(200);
  });
});

describe("POST — the block", () => {
  it("inserts with the creator stamped, logs, re-prices after the response", async () => {
    const res = await post({ ...GOOD, reason: "  Flood damage  " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const row = fake().tables.get("room_type_out_of_service")!.find((r) => r.id === body.id)!;
    expect(row).toMatchObject({
      hotel_id: HOTEL,
      room_type_id: ROOM,
      start_date: "2026-11-01",
      end_date: "2026-11-10",
      units: 3,
      reason: "Flood damage",
      created_by: USER,
    });
    const log = fake().rpcs.find((r) => r.name === "platform_log_event")!;
    expect(log.args).toMatchObject({
      p_event_type: "room_type.out_of_service",
      p_entity_id: ROOM,
      p_hotel_id: HOTEL,
      p_detail: { action: "added", room_type_id: ROOM, name: "Standard", units: 3, actor_user_id: USER },
    });
    // Bounded horizon: the route's wall clock cannot fit the full 365.
    expect(evaluateHotel).not.toHaveBeenCalled();
    await flushAfter();
    expect(evaluateHotel).toHaveBeenCalledWith(fake(), HOTEL, undefined, 60);
  });

  it("refuses a block that would stack past the type's count on an overlapping night", async () => {
    // 4 already out Oct 1-14 on a 20-room type; another 17 over Oct 10-20
    // would sell -1 rooms on Oct 10-14. The message says how many are left.
    const res = await post({ ...GOOD, startDate: "2026-10-10", endDate: "2026-10-20", units: 17 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already has 4 rooms out of service.*16 you can still block/);
    expect(fake().tables.get("room_type_out_of_service")).toHaveLength(1);
    // Exactly what is left is fine, and a range that only touches a
    // different block's nights is not stacked with it.
    expect((await post({ ...GOOD, startDate: "2026-10-10", endDate: "2026-10-20", units: 16 })).status).toBe(200);
    expect((await post({ ...GOOD, startDate: "2026-10-15", endDate: "2026-10-20", units: 4 })).status).toBe(200);
  });

  it("503 before the migration, never a 500 — in both shapes the server can send", async () => {
    for (const shape of ["postgrest", "pg"] as const) {
      state.fake = seed({ missingTables: ["room_type_out_of_service"], missingTableShape: shape });
      const res = await post(GOOD);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("This needs a database update first.");
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("pre-migration"));
  });
});

describe("DELETE", () => {
  it("stamps cleared_at/cleared_by, logs, re-prices", async () => {
    const res = await del({ hotelId: HOTEL, id: BLOCK });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, id: BLOCK, cleared_by: USER });
    const row = fake().tables.get("room_type_out_of_service")![0];
    expect(row.cleared_by).toBe(USER);
    expect(typeof row.cleared_at).toBe("string");
    expect(fake().rpcs.find((r) => r.name === "platform_log_event")!.args.p_detail).toMatchObject({
      action: "cleared",
      id: BLOCK,
      units: 4,
      actor_user_id: USER,
    });
    await flushAfter();
    expect(evaluateHotel).toHaveBeenCalledTimes(1);
  });

  it("404 for a block already cleared, and nothing logged", async () => {
    await del({ hotelId: HOTEL, id: BLOCK });
    fake().rpcs.length = 0;
    const res = await del({ hotelId: HOTEL, id: BLOCK });
    expect(res.status).toBe(404);
    expect(fake().rpcs.filter((r) => r.name === "platform_log_event")).toEqual([]);
  });

  it("400 for an id that is not a uuid; 503 before the migration", async () => {
    expect((await del({ hotelId: HOTEL, id: "nope" })).status).toBe(400);
    state.fake = seed({ missingTables: ["room_type_out_of_service"] });
    expect((await del({ hotelId: HOTEL, id: BLOCK })).status).toBe(503);
  });
});

describe("GET", () => {
  it("lists only open blocks for the hotel", async () => {
    await post(GOOD);
    await del({ hotelId: HOTEL, id: BLOCK });
    const res = await get();
    expect(res.status).toBe(200);
    const { blocks } = await res.json();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ room_type_id: ROOM, start_date: "2026-11-01", units: 3, reason: null });
  });

  it("401 signed out, 400 without a hotel, 503 before the migration", async () => {
    state.userId = null;
    expect((await get()).status).toBe(401);
    state.userId = USER;
    expect((await get("")).status).toBe(400);
    state.fake = seed({ missingTables: ["room_type_out_of_service"] });
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("This needs a database update first.");
  });
});
