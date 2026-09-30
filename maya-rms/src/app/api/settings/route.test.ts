/**
 * The Settings routes: loading what Settings shows, saving the property's
 * calendar (Revenue Manager and up, the same can_manage_hotel check as rules
 * and manual prices, a platform admin only in God Mode) and saving a
 * person's own text size on their profile. A small in-memory fake stands in
 * for Supabase and answers the way row level security would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOD_MODE_OFF } from "@/lib/admin/god-mode";
import { NOT_READY_YET } from "@/lib/api-guards";
import { DEFAULT_CALENDAR_DISPLAY } from "@/lib/calendar-display";

type Row = Record<string, unknown>;

const USER = "11111111-1111-4111-8111-111111111111";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const OTHER_HOTEL = "22222222-2222-4222-8222-222222222223";
const KING = "33333333-3333-4333-8333-333333333331";
const RETIRED = "33333333-3333-4333-8333-333333333332";
const NEIGHBOUR = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({
  configured: true,
  userId: null as string | null,
  canManage: true,
  isAdmin: false,
  /** Columns the database does not have yet (42703). */
  missing: [] as string[],
  tables: {} as Record<string, Record<string, unknown>[]>,
  writes: [] as { table: string; patch: Record<string, unknown> }[],
}));

function builder(table: string) {
  const filters: [string, unknown][] = [];
  let patch: Row | null = null;
  let columns = "";
  const run = async (single: boolean) => {
    const touched = `${columns} ${Object.keys(patch ?? {}).join(" ")}`;
    const gone = state.missing.find((c) => touched.includes(c));
    if (gone) return { data: null, error: { code: "42703", message: `column "${gone}" does not exist` } };
    let rows = (state.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    if (patch) {
      // Row level security: an update the person may not make reaches no rows.
      if (table === "hotel_settings" && !state.canManage) rows = [];
      if (table === "profiles") rows = rows.filter((r) => r.id === state.userId);
      for (const r of rows) Object.assign(r, patch);
      state.writes.push({ table, patch });
    }
    return { data: single ? (rows[0] ?? null) : rows.map((r) => ({ ...r })), error: null };
  };
  const api = {
    select(cols = "*") {
      columns = cols;
      return api;
    },
    eq(col: string, val: unknown) {
      filters.push([col, val]);
      return api;
    },
    update(next: Row) {
      patch = next;
      return api;
    },
    maybeSingle: () => run(true),
    then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
      return run(false).then(resolve, reject);
    },
  };
  return api;
}

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => state.configured }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }) },
    rpc: async (name: string) => {
      if (name === "can_manage_hotel") return { data: state.canManage, error: null };
      if (name === "is_platform_admin") return { data: state.isAdmin, error: null };
      return { data: null, error: null };
    },
    from: (t: string) => builder(t),
  }),
}));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));

const { GET } = await import("./route");
const { PUT: putCalendar } = await import("./calendar/route");
const { PUT: putDisplay } = await import("./display/route");
const { PROPERTY_SETTINGS_FORBIDDEN } = await import("./gate");

function seed() {
  state.tables = {
    hotel_settings: [
      {
        hotel_id: HOTEL,
        simulation_mode: false,
        calendar_big_metric: "occupancy",
        calendar_small_metric_1: "rooms_booked",
        calendar_small_metric_2: "room_revenue",
        calendar_price_room_type_id: null,
        calendar_colors: "standard",
      },
    ],
    room_types: [
      { id: KING, hotel_id: HOTEL, name: "King", is_active: true },
      { id: RETIRED, hotel_id: HOTEL, name: "Old Twin", is_active: false },
      { id: NEIGHBOUR, hotel_id: OTHER_HOTEL, name: "Their King", is_active: true },
    ],
    profiles: [{ id: USER, text_size: "large" }],
  };
}

const put = (handler: (r: Request) => Promise<Response>, url: string, body: unknown) =>
  handler(new Request(`http://localhost${url}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const settingsRow = () => state.tables.hotel_settings[0];

beforeEach(() => {
  state.configured = true;
  state.userId = USER;
  state.canManage = true;
  state.isAdmin = false;
  state.missing = [];
  state.writes = [];
  seed();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/settings", () => {
  it("gives someone who can manage the property its calendar and their own text size", async () => {
    settingsRow().calendar_colors = "reversed";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      property: { canEdit: true, readOnly: null },
      calendar: { big: "occupancy", small: ["rooms_booked", "room_revenue"], price_room_type_id: null, colors: "reversed" },
      textSize: "large",
    });
  });

  it("shows the property's calendar read-only to everyone else, with the reason", async () => {
    state.canManage = false;
    const body = await (await GET()).json();
    expect(body.property).toEqual({ canEdit: false, readOnly: PROPERTY_SETTINGS_FORBIDDEN });
    expect(body.calendar.big).toBe("occupancy");
  });

  it("tells MAYA staff outside God Mode how to change it, not which role they lack", async () => {
    state.canManage = false;
    state.isAdmin = true;
    expect((await (await GET()).json()).property).toEqual({ canEdit: false, readOnly: GOD_MODE_OFF });
  });

  it("shows the calendar as it always was on a database before the migration", async () => {
    state.missing = ["calendar_big_metric", "text_size"];
    const body = await (await GET()).json();
    expect(body.calendar).toEqual(DEFAULT_CALENDAR_DISPLAY);
    expect(body.textSize).toBeNull();
  });

  it("needs a signed-in person", async () => {
    state.userId = null;
    expect((await GET()).status).toBe(401);
  });
});

describe("PUT /api/settings/calendar", () => {
  const choice = { big: "adr", small: ["occupancy", "price"], price_room_type_id: KING, colors: "reversed" };

  it("saves the property's choices for everyone and answers what was saved", async () => {
    const res = await put(putCalendar, "/api/settings/calendar", choice);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calendar: choice });
    expect(settingsRow()).toMatchObject({
      calendar_big_metric: "adr",
      calendar_small_metric_1: "occupancy",
      calendar_small_metric_2: "price",
      calendar_price_room_type_id: KING,
      calendar_colors: "reversed",
      // Nothing else on the row moves.
      simulation_mode: false,
    });
  });

  it("refuses someone who cannot manage the property, and changes nothing", async () => {
    state.canManage = false;
    const res = await put(putCalendar, "/api/settings/calendar", choice);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PROPERTY_SETTINGS_FORBIDDEN, code: "forbidden" });
    expect(state.writes).toEqual([]);
    expect(settingsRow().calendar_big_metric).toBe("occupancy");
  });

  it("refuses MAYA staff outside God Mode, and says how to turn it on", async () => {
    state.canManage = false;
    state.isAdmin = true;
    const res = await put(putCalendar, "/api/settings/calendar", choice);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(GOD_MODE_OFF);
  });

  it("lets MAYA staff save in God Mode, through the same row level security", async () => {
    // can_manage_hotel() is true for an admin only while God Mode is on.
    state.isAdmin = true;
    expect((await put(putCalendar, "/api/settings/calendar", choice)).status).toBe(200);
  });

  it("refuses a choice outside the rules with a sentence the owner can act on", async () => {
    const res = await put(putCalendar, "/api/settings/calendar", { ...choice, small: ["adr"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Each number can show once on a day.");
    expect(state.writes).toEqual([]);
  });

  it("takes a price only from one of the property's own active room types", async () => {
    for (const rt of [NEIGHBOUR, RETIRED, "44444444-4444-4444-8444-444444444444"]) {
      const res = await put(putCalendar, "/api/settings/calendar", { ...choice, price_room_type_id: rt });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Pick a room type from the list.");
    }
    expect(state.writes).toEqual([]);
  });

  it("remembers the room type while no price shows, if it is the property's own", async () => {
    await put(putCalendar, "/api/settings/calendar", { big: "occupancy", small: [], price_room_type_id: RETIRED, colors: "standard" });
    expect(settingsRow().calendar_price_room_type_id).toBe(RETIRED);
    await put(putCalendar, "/api/settings/calendar", { big: "occupancy", small: [], price_room_type_id: NEIGHBOUR, colors: "standard" });
    expect(settingsRow().calendar_price_room_type_id).toBeNull();
  });

  it("says it is ours to fix on a database before the migration", async () => {
    state.missing = ["calendar_big_metric"];
    const res = await put(putCalendar, "/api/settings/calendar", { big: "adr", small: [], price_room_type_id: null, colors: "standard" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(NOT_READY_YET);
  });

  it("never makes a settings row a property does not have", async () => {
    state.tables.hotel_settings = [];
    const res = await put(putCalendar, "/api/settings/calendar", { big: "adr", small: [], price_room_type_id: null, colors: "standard" });
    expect(res.status).toBe(503);
    expect(state.tables.hotel_settings).toEqual([]);
  });

  it("needs a database in demo mode", async () => {
    state.configured = false;
    expect((await put(putCalendar, "/api/settings/calendar", choice)).status).toBe(501);
  });
});

describe("PUT /api/settings/display", () => {
  it("saves the text size on the person's own profile", async () => {
    const res = await put(putDisplay, "/api/settings/display", { textSize: "larger" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ textSize: "larger" });
    expect(state.tables.profiles[0].text_size).toBe("larger");
  });

  it("is anyone's own choice, whatever their role", async () => {
    state.canManage = false;
    expect((await put(putDisplay, "/api/settings/display", { textSize: "standard" })).status).toBe(200);
    expect(state.tables.profiles[0].text_size).toBe("standard");
  });

  it("refuses a size that is not on the list", async () => {
    const res = await put(putDisplay, "/api/settings/display", { textSize: "huge" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Pick Standard, Large or Larger.");
  });

  it("says it is ours to fix on a database before the migration", async () => {
    state.missing = ["text_size"];
    const res = await put(putDisplay, "/api/settings/display", { textSize: "large" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(NOT_READY_YET);
  });
});

describe("demo mode", () => {
  it("shows the default calendar read-only", async () => {
    state.configured = false;
    const body = await (await GET()).json();
    expect(body.property.canEdit).toBe(false);
    expect(body.calendar).toEqual(DEFAULT_CALENDAR_DISPLAY);
  });
});
