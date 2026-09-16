/**
 * The room-types route: the list every room-type picker reads, and the PATCH
 * that flips "counts as a room". The list has to keep working on a database
 * that has not had the classification migration yet, and every flip has to
 * leave an audit line and a re-price behind it.
 *
 * A small in-memory fake stands in for Supabase; the engine and the limiter
 * are mocked so nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

function fakeSupabase(seed: Record<string, Row[]> = {}, opts: { missingColumn?: string; missingTables?: string[] } = {}) {
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
    let columns = "";
    let single = false;

    const api = {
      select(cols = "*") {
        columns = cols;
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
        return { data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } };
      }
      const touched = `${columns} ${Object.keys(patch ?? {}).join(" ")} ${pending.flatMap((p) => Object.keys(p)).join(" ")}`;
      if (opts.missingColumn && touched.includes(opts.missingColumn)) {
        return { data: null, error: { code: "42703", message: `column "${opts.missingColumn}" does not exist` } };
      }
      if (mode === "insert") {
        const rows = tableOf(table);
        const made = pending.map((p, i) => ({ id: `made-${rows.length + i}`, ...p }));
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
const COURT = "44444444-4444-4444-8444-444444444444";

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
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    enforceRateLimit: async (_name: string, _subject: string, message?: string) =>
      state.throttled ? NextResponse.json({ error: message }, { status: 429 }) : null,
  };
});
vi.mock("@/lib/engine", () => ({ evaluateHotel }));

const { GET, PATCH, fallbackSeed, isCountingRoom } = await import("./route");

function seed(opts?: Parameters<typeof fakeSupabase>[1]) {
  return fakeSupabase(
    {
      hotels: [{ id: HOTEL, timezone: "UTC" }],
      room_types: [
        { id: ROOM, hotel_id: HOTEL, name: "Standard", display_name: null, total_rooms: 20, floor_price: 100, ceiling_price: 400, is_active: true, counts_as_room: null },
        { id: COURT, hotel_id: HOTEL, name: "Pickleball Court", display_name: null, total_rooms: 2, floor_price: 1, ceiling_price: 99999.99, is_active: true, counts_as_room: false },
      ],
      manual_price: [],
      published_price: [],
    },
    opts,
  );
}

function get(query = "") {
  return GET(new Request(`http://localhost/api/room-types${query}`));
}
function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/room-types", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
async function flushAfter() {
  const fns = afterCalls.splice(0);
  for (const fn of fns) await fn();
}
const fake = () => state.fake as ReturnType<typeof fakeSupabase>;

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

describe("fallbackSeed: the starting price when nothing is published yet", () => {
  it("uses the midpoint when the owner set real guardrails", () => {
    expect(fallbackSeed(100, 300)).toBe(200);
  });

  it("refuses the midpoint of MAYA's no-limit default", () => {
    // floor 1 / ceiling 99999.99 is what an unconstrained room type carries.
    // Its midpoint is $50,000, which would open the simulator on nonsense.
    expect(fallbackSeed(1, 99999.99)).toBe(1);
  });

  it("holds the line exactly at ten times the floor", () => {
    expect(fallbackSeed(100, 1000)).toBe(550);
    expect(fallbackSeed(100, 1000.01)).toBe(100);
  });

  it("never returns zero or a negative, whatever the guardrails say", () => {
    expect(fallbackSeed(0, 0)).toBe(1);
    expect(fallbackSeed(-50, 200)).toBe(1);
  });
});

describe("isCountingRoom", () => {
  it("counts unless explicitly told not to — null is a room", () => {
    expect(isCountingRoom({ counts_as_room: null })).toBe(true);
    expect(isCountingRoom({})).toBe(true);
    expect(isCountingRoom({ counts_as_room: true })).toBe(true);
    expect(isCountingRoom({ counts_as_room: false })).toBe(false);
  });
});

describe("GET /api/room-types", () => {
  it("lists every active type with its flag for the rules form", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(rows.find((r: Row) => r.id === COURT).counts_as_room).toBe(false);
    expect(rows.find((r: Row) => r.id === ROOM).counts_as_room).toBeNull();
  });

  it("seeds the simulator with rooms only, unless asked for everything", async () => {
    const seeded = await (await get("?withRate=1")).json();
    expect(seeded.roomTypes.map((r: Row) => r.id)).toEqual([ROOM]);
    const all = await (await get("?withRate=1&all=1")).json();
    expect(all.roomTypes.map((r: Row) => r.id).sort()).toEqual([ROOM, COURT].sort());
  });

  it("still answers before the migration: every type a room, flag null, warning logged", async () => {
    state.fake = seed({ missingColumn: "counts_as_room" });
    const res = await get();
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(rows.every((r: Row) => r.counts_as_room === null)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("pre-migration"));
    // ...and the simulator seed keeps everything, as it always did.
    const seeded = await (await get("?withRate=1")).json();
    expect(seeded.roomTypes).toHaveLength(2);
  });
});

describe("PATCH /api/room-types — doors", () => {
  const GOOD = { hotelId: HOTEL, roomTypeId: ROOM, countsAsRoom: false };

  it("401 when signed out", async () => {
    state.userId = null;
    expect((await patch(GOOD)).status).toBe(401);
  });

  it("403 below Revenue Manager, naming the rank, writing nothing", async () => {
    state.canManage = false;
    const res = await patch(GOOD);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Revenue Manager access or higher/);
    expect(fake().tables.get("room_types")!.find((r) => r.id === ROOM)!.counts_as_room).toBeNull();
  });

  it("429 when the budget is spent", async () => {
    state.throttled = true;
    expect((await patch(GOOD)).status).toBe(429);
  });

  const cases: [string, unknown, RegExp][] = [
    ["a hotel id that is not a uuid", { ...GOOD, hotelId: "x" }, /property/],
    ["a room type id that is not a uuid", { ...GOOD, roomTypeId: "x" }, /room type/],
    ["a flag that is not a boolean", { ...GOOD, countsAsRoom: "no" }, /true or false/],
    ["a room type from another property", { ...GOOD, roomTypeId: "77777777-7777-4777-8777-777777777777" }, /isn't on this property/],
  ];
  for (const [label, body, message] of cases) {
    it(`400 for ${label}`, async () => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(message);
      expect(fake().rpcs.filter((r) => r.name === "platform_log_event")).toEqual([]);
    });
  }
});

describe("PATCH /api/room-types — the flip", () => {
  it("writes the flag, logs who/what/before/after, and re-prices behind the response", async () => {
    const res = await patch({ hotelId: HOTEL, roomTypeId: ROOM, countsAsRoom: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fake().tables.get("room_types")!.find((r) => r.id === ROOM)!.counts_as_room).toBe(false);

    const log = fake().rpcs.find((r) => r.name === "platform_log_event")!;
    expect(log.args).toMatchObject({
      p_event_type: "room_type.classified",
      p_entity_type: "room_type",
      p_entity_id: ROOM,
      p_hotel_id: HOTEL,
      p_detail: { room_type_id: ROOM, name: "Standard", before: null, after: false, via: "settings" },
    });

    // The response went out before the engine ran, and it runs a bounded
    // horizon — the full 365 does not fit inside the route's wall clock.
    expect(evaluateHotel).not.toHaveBeenCalled();
    await flushAfter();
    expect(evaluateHotel).toHaveBeenCalledWith(fake(), HOTEL, undefined, 45);
  });

  it("stamps who decided on the row and names them in the audit line", async () => {
    await patch({ hotelId: HOTEL, roomTypeId: ROOM, countsAsRoom: false });
    const row = fake().tables.get("room_types")!.find((r) => r.id === ROOM)!;
    expect(row.counts_as_room_set_by).toBe(USER);
    // platform_log_event records auth.uid(), which is null on the service
    // role; without this the row says nobody reclassified the suite.
    const log = fake().rpcs.find((r) => r.name === "platform_log_event")!;
    expect(log.args.p_detail).toMatchObject({ actor_user_id: USER });
  });

  it("honours MAYA_EVAL_HORIZON_DAYS for the re-price", async () => {
    vi.stubEnv("MAYA_EVAL_HORIZON_DAYS", "60");
    await patch({ hotelId: HOTEL, roomTypeId: ROOM, countsAsRoom: false });
    await flushAfter();
    expect(evaluateHotel).toHaveBeenCalledWith(fake(), HOTEL, undefined, 60);
    vi.unstubAllEnvs();
  });

  it("writes the flag without provenance when only the set_by column is missing, and says so", async () => {
    // The migration was run once before counts_as_room_set_by was added to
    // it. The answer still lands; the re-run is asked for in the log.
    state.fake = seed({ missingColumn: "counts_as_room_set_by" });
    const res = await patch({ hotelId: HOTEL, roomTypeId: ROOM, countsAsRoom: false });
    expect(res.status).toBe(200);
    const row = fake().tables.get("room_types")!.find((r) => r.id === ROOM)!;
    expect(row.counts_as_room).toBe(false);
    expect(row).not.toHaveProperty("counts_as_room_set_by");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("counts_as_room_set_by"));
    expect(fake().rpcs.find((r) => r.name === "platform_log_event")!.args.p_detail).toMatchObject({ actor_user_id: USER });
  });

  it("a no-op flip on the owner's own answer neither logs nor re-prices", async () => {
    fake().tables.get("room_types")!.find((r) => r.id === COURT)!.counts_as_room_set_by = USER;
    const res = await patch({ hotelId: HOTEL, roomTypeId: COURT, countsAsRoom: false });
    expect(res.status).toBe(200);
    expect(fake().rpcs.filter((r) => r.name === "platform_log_event")).toEqual([]);
    await flushAfter();
    expect(evaluateHotel).not.toHaveBeenCalled();
  });

  it("confirming the import's guess stamps the owner on it and logs, but has nothing to re-price", async () => {
    // The court was `false` by the name heuristic (set_by null). The owner
    // saying the same thing is what turns "we guessed" into "you marked".
    const res = await patch({ hotelId: HOTEL, roomTypeId: COURT, countsAsRoom: false });
    expect(res.status).toBe(200);
    expect(fake().tables.get("room_types")!.find((r) => r.id === COURT)!.counts_as_room_set_by).toBe(USER);
    const log = fake().rpcs.find((r) => r.name === "platform_log_event")!;
    expect(log.args.p_detail).toMatchObject({ before: false, after: false, confirmed_guess: true, actor_user_id: USER });
    await flushAfter();
    expect(evaluateHotel).not.toHaveBeenCalled();
  });

  it("re-ticking a suspect records the reversal", async () => {
    await patch({ hotelId: HOTEL, roomTypeId: COURT, countsAsRoom: true });
    const log = fake().rpcs.find((r) => r.name === "platform_log_event")!;
    expect(log.args.p_detail).toMatchObject({ before: false, after: true });
  });

  it("503 with a plain message before the migration — never a 500", async () => {
    state.fake = seed({ missingColumn: "counts_as_room" });
    const res = await patch({ hotelId: HOTEL, roomTypeId: ROOM, countsAsRoom: false });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("This needs a database update first.");
    await flushAfter();
    expect(evaluateHotel).not.toHaveBeenCalled();
  });

  it("a failed engine run is logged, not surfaced", async () => {
    evaluateHotel.mockRejectedValueOnce(new Error("boom"));
    const res = await patch({ hotelId: HOTEL, roomTypeId: ROOM, countsAsRoom: false });
    expect(res.status).toBe(200);
    await flushAfter();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
