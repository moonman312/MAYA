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
  /** Tables whose reads fail just now (a timeout, say). */
  failReads: [] as string[],
  tables: {} as Record<string, Record<string, unknown>[]>,
  writes: [] as { table: string; patch: Record<string, unknown> }[],
  /** Future nights still keeping a rate changed in the PMS, as set_pms_rate_changes counts them. */
  pmsNights: 0,
  /** The error set_pms_rate_changes answers with, if any. */
  pmsRpcError: null as { code?: string; message: string } | null,
  rpcCalls: [] as { name: string; args: unknown }[],
  nudges: [] as string[],
}));

function builder(table: string) {
  const filters: [string, unknown][] = [];
  let patch: Row | null = null;
  let columns = "";
  const run = async (single: boolean) => {
    const touched = `${columns} ${Object.keys(patch ?? {}).join(" ")}`;
    const gone = state.missing.find((c) => touched.includes(c));
    if (gone) return { data: null, error: { code: "42703", message: `column "${gone}" does not exist` } };
    if (!patch && state.failReads.includes(table)) {
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    }
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
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (name === "can_manage_hotel") return { data: state.canManage, error: null };
      if (name === "is_platform_admin") return { data: state.isAdmin, error: null };
      if (name === "set_pms_rate_changes") {
        // The database's own check, as the function makes it.
        if (!state.canManage) return { data: null, error: { code: "42501", message: "not allowed to change this property's settings" } };
        if (state.pmsRpcError) return { data: null, error: state.pmsRpcError };
        const row = state.tables.hotel_settings[0];
        const turningOn = args.p_mode === "maya_wins" && row.pms_rate_changes !== "maya_wins";
        if (turningOn && state.pmsNights > 0 && args.p_replace !== true) {
          return { data: { saved: false, reason: "confirm", mode: row.pms_rate_changes, nights: state.pmsNights }, error: null };
        }
        const nights = turningOn ? state.pmsNights : 0;
        row.pms_rate_changes = args.p_mode;
        state.pmsNights -= nights;
        return { data: { saved: true, mode: args.p_mode, nights, cleared_prices: nights, handed_back: 0 }, error: null };
      }
      return { data: null, error: null };
    },
    from: (t: string) => builder(t),
  }),
}));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => true, createAdminClient: () => ({}) }));
vi.mock("@/lib/pms/sync-nudge", () => ({
  nudgeHotelSync: async (_admin: unknown, hotelId: string) => {
    state.nudges.push(hotelId);
    return "nudged";
  },
}));

const { GET } = await import("./route");
const { PUT: putCalendar } = await import("./calendar/route");
const { PUT: putPms } = await import("./pms/route");
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
        pms_rate_changes: "keep",
      },
    ],
    pms_connections: [
      { hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected", updated_at: "2026-09-01T00:00:00Z" },
      { hotel_id: HOTEL, pms_type: "mews", status: "disconnected", updated_at: "2026-09-20T00:00:00Z" },
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
  state.failReads = [];
  state.writes = [];
  state.pmsNights = 0;
  state.pmsRpcError = null;
  state.rpcCalls = [];
  state.nudges = [];
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
      pms: { type: "cloudbeds", name: "Cloudbeds", mode: "keep" },
      textSize: "large",
    });
  });

  it("names the property system the setting is about, and hides it where MAYA reads no changes", async () => {
    settingsRow().pms_rate_changes = "maya_wins";
    expect((await (await GET()).json()).pms).toEqual({ type: "cloudbeds", name: "Cloudbeds", mode: "maya_wins" });
    state.tables.pms_connections = [{ hotel_id: HOTEL, pms_type: "think", status: "connected", updated_at: "2026-09-01T00:00:00Z" }];
    expect((await (await GET()).json()).pms).toEqual({ type: "think", name: "Think Reservations", mode: "maya_wins" });
    state.tables.pms_connections = [{ hotel_id: HOTEL, pms_type: "mews", status: "connected", updated_at: "2026-09-01T00:00:00Z" }];
    expect((await (await GET()).json()).pms).toBeNull();
    state.tables.pms_connections = [];
    expect((await (await GET()).json()).pms).toBeNull();
  });

  it("reads as Keep the change on a database before the setting", async () => {
    state.missing = ["pms_rate_changes"];
    expect((await (await GET()).json()).pms).toEqual({ type: "cloudbeds", name: "Cloudbeds", mode: "keep" });
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

  it("says the calendar choices couldn't be read, rather than offering the defaults to save over them", async () => {
    settingsRow().calendar_big_metric = "adr";
    settingsRow().calendar_colors = "reversed";
    state.failReads = ["hotel_settings"];
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calendar).toBeNull();
    expect(body.textSize).toBe("large");
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

  it("saves only what changed, so it never puts back a choice someone else saved since", async () => {
    // Someone else picked ADR and a price after this person opened Settings.
    Object.assign(settingsRow(), { calendar_big_metric: "adr", calendar_small_metric_1: "price", calendar_small_metric_2: null, calendar_price_room_type_id: KING });
    const res = await put(putCalendar, "/api/settings/calendar", { colors: "reversed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calendar: { big: "adr", small: ["price"], price_room_type_id: KING, colors: "reversed" } });
    expect(state.writes.map((w) => Object.keys(w.patch).sort())).toEqual([["calendar_colors", "updated_at"]]);

    state.writes = [];
    await put(putCalendar, "/api/settings/calendar", { big: "occupancy", small: ["price"] });
    expect(settingsRow()).toMatchObject({ calendar_big_metric: "occupancy", calendar_small_metric_1: "price", calendar_colors: "reversed", calendar_price_room_type_id: KING });
    expect(Object.keys(state.writes[0].patch).sort()).toEqual([
      "calendar_big_metric",
      "calendar_small_metric_1",
      "calendar_small_metric_2",
      "updated_at",
    ]);
  });

  it("saves the colours even when the price's room type has since gone", async () => {
    // Deleting a room type sets the stored one to null.
    Object.assign(settingsRow(), { calendar_big_metric: "price", calendar_small_metric_1: null, calendar_small_metric_2: null, calendar_price_room_type_id: null });
    expect((await put(putCalendar, "/api/settings/calendar", { colors: "reversed" })).status).toBe(200);
    expect(settingsRow().calendar_colors).toBe("reversed");
    const res = await put(putCalendar, "/api/settings/calendar", { big: "price", small: ["adr"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Pick the room type whose price to show.");
  });

  it("changes nothing when what is saved can't be read", async () => {
    state.failReads = ["hotel_settings"];
    const res = await put(putCalendar, "/api/settings/calendar", { colors: "reversed" });
    expect(res.status).toBe(500);
    expect(state.writes).toEqual([]);
  });
});

describe("PUT /api/settings/pms", () => {
  it("turns MAYA's price wins on and off when nothing kept from the PMS is in the way", async () => {
    const on = await put(putPms, "/api/settings/pms", { mode: "maya_wins" });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ mode: "maya_wins", replaced: 0 });
    expect(settingsRow().pms_rate_changes).toBe("maya_wins");
    const off = await put(putPms, "/api/settings/pms", { mode: "keep" });
    expect(await off.json()).toEqual({ mode: "keep", replaced: 0 });
    expect(settingsRow().pms_rate_changes).toBe("keep");
    expect(state.nudges).toEqual([]);
  });

  it("asks first when nights keep a rate changed in the PMS, then replaces them and sends MAYA's prices now", async () => {
    state.pmsNights = 3;
    const asked = await put(putPms, "/api/settings/pms", { mode: "maya_wins" });
    expect(asked.status).toBe(409);
    expect(await asked.json()).toEqual({ confirm: { nights: 3 } });
    expect(settingsRow().pms_rate_changes).toBe("keep");

    const done = await put(putPms, "/api/settings/pms", { mode: "maya_wins", replace: true });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ mode: "maya_wins", replaced: 3, sending: "nudged" });
    expect(settingsRow().pms_rate_changes).toBe("maya_wins");
    expect(state.nudges).toEqual([HOTEL]);
    expect(state.rpcCalls.filter((c) => c.name === "set_pms_rate_changes").map((c) => c.args)).toEqual([
      { p_hotel_id: HOTEL, p_mode: "maya_wins", p_replace: false },
      { p_hotel_id: HOTEL, p_mode: "maya_wins", p_replace: true },
    ]);
  });

  it("refuses someone who cannot manage the property before asking the database", async () => {
    state.canManage = false;
    const res = await put(putPms, "/api/settings/pms", { mode: "maya_wins", replace: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PROPERTY_SETTINGS_FORBIDDEN, code: "forbidden" });
    expect(state.rpcCalls.some((c) => c.name === "set_pms_rate_changes")).toBe(false);
    expect(settingsRow().pms_rate_changes).toBe("keep");
  });

  it("refuses MAYA staff outside God Mode, and says how to turn it on", async () => {
    state.canManage = false;
    state.isAdmin = true;
    expect((await (await put(putPms, "/api/settings/pms", { mode: "maya_wins" })).json()).error).toBe(GOD_MODE_OFF);
  });

  it("takes only the two choices", async () => {
    for (const body of [{ mode: "overwrite" }, { mode: null }, {}]) {
      const res = await put(putPms, "/api/settings/pms", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Pick one of the two choices.");
    }
  });

  it("says it is ours to fix on a database before the setting, and refuses what the database refuses", async () => {
    state.pmsRpcError = { code: "PGRST202", message: "Could not find the function public.set_pms_rate_changes" };
    let res = await put(putPms, "/api/settings/pms", { mode: "maya_wins" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(NOT_READY_YET);
    state.pmsRpcError = { code: "42501", message: "not allowed" };
    res = await put(putPms, "/api/settings/pms", { mode: "maya_wins" });
    expect(res.status).toBe(403);
    state.pmsRpcError = { code: "57014", message: "canceling statement due to statement timeout" };
    res = await put(putPms, "/api/settings/pms", { mode: "maya_wins" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Could not save this setting. Try again in a moment.");
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
