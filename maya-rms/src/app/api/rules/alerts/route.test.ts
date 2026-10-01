/**
 * The rule alert routes: what a hotel sees, and who may answer.
 *
 * A viewer can read an alert and cannot answer it, which is the same line
 * can_manage_hotel draws in the database. The answer goes through
 * rule_repeat_alert_choose with the nights the caller named, and the refreshed
 * list comes back so the banner never asks twice. A minimal in-memory fake
 * stands in for Supabase; the role check is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter =
  | ["eq", string, unknown]
  | ["in", string, unknown[]]
  | ["isNull", string]
  | ["notNull", string];

const HOTEL = "00000000-0000-4000-8000-000000000001";
const OTHER_HOTEL = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000a1";
const RULE = "00000000-0000-4000-8000-000000000031";
const ALERT = "00000000-0000-4000-8000-000000000041";
const STD = "00000000-0000-4000-8000-000000000021";

function fakeSupabase(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      const v = row[f[1]];
      if (f[0] === "eq") return v === f[2];
      if (f[0] === "in") return f[2].includes(v);
      if (f[0] === "isNull") return v == null;
      return v != null;
    });

  // Orders, limits and pages the way PostgREST does, at its 1,000-row cap, so
  // a read that leans on them is tested as it runs.
  function builder(table: string) {
    const filters: Filter[] = [];
    const orders: { col: string; ascending: boolean }[] = [];
    let window: [number, number] = [0, 999];
    const rows = () => {
      const out = (tables.get(table) ?? []).filter((r) => matches(r, filters));
      out.sort((a, b) => {
        for (const o of orders) {
          const [x, y] = [String(a[o.col]), String(b[o.col])];
          if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
        }
        return 0;
      });
      return out.slice(window[0], Math.min(window[1], window[0] + 999) + 1);
    };
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), api),
      in: (c: string, v: unknown[]) => (filters.push(["in", c, v]), api),
      is: (c: string) => (filters.push(["isNull", c]), api),
      not: (c: string) => (filters.push(["notNull", c]), api),
      gte: () => api,
      lte: () => api,
      order: (c: string, o?: { ascending?: boolean }) => (orders.push({ col: c, ascending: o?.ascending !== false }), api),
      limit: (n: number) => ((window = [0, n - 1]), api),
      range: (a: number, z: number) => ((window = [a, z]), api),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return api;
  }
  return { from: (t: string) => builder(t), tables };
}

const state = {
  fake: fakeSupabase({}),
  role: "revenue_manager" as string | null,
  hotelId: HOTEL as string | null,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  events: [] as { event: string; properties: Record<string, unknown> }[],
};

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => state.hotelId }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USER } } }),
      getSession: async () => ({ data: { session: { user: { id: USER } } } }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (name === "is_platform_admin") return { data: false, error: null };
      if (name === "rule_repeat_alert_choose") {
        const nights = (state.fake.tables.get("rule_repeat_alert_nights") ?? []).filter(
          (n) =>
            n.alert_id === args.p_alert_id &&
            (args.p_stay_dates == null || (args.p_stay_dates as string[]).includes(String(n.stay_date))),
        );
        for (const n of nights) {
          n.choice = args.p_choice;
          n.chosen_at = "2026-09-17T12:00:00Z";
        }
        return { data: nights.map((n) => ({ ...n })), error: null };
      }
      if (name === "rule_repeat_alert_resume") {
        const nights = (state.fake.tables.get("rule_repeat_alert_nights") ?? []).filter(
          (n) =>
            n.alert_id === args.p_alert_id &&
            n.choice != null &&
            (args.p_stay_dates == null || (args.p_stay_dates as string[]).includes(String(n.stay_date))),
        );
        for (const n of nights) {
          n.choice = null;
          n.chosen_at = null;
          n.chosen_by = null;
          n.closed_at = "2026-09-17T12:00:00Z";
          n.closed_reason = "resumed";
        }
        return { data: nights.map((n) => ({ ...n })), error: null };
      }
      return { data: null, error: null };
    },
    from: (t: string) => state.fake.from(t),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "product_event_emit") {
        state.events.push({
          event: String(args.p_event),
          properties: args.p_properties as Record<string, unknown>,
        });
      }
      return { data: null, error: null };
    },
  }),
}));

const { GET } = await import("./route");
const { POST } = await import("./[alertId]/route");

function seed(over: Record<string, Row[]> = {}) {
  return fakeSupabase({
    hotels: [{ id: HOTEL, currency: "USD" }],
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
    hotel_memberships: [{ hotel_id: HOTEL, user_id: USER, status: "active", role: state.role ?? "viewer" }],
    pricing_rules: [{ id: RULE, name: "Slow-date rescue" }],
    room_types: [{ id: STD, name: "Standard" }],
    rule_repeat_alerts: [
      {
        id: ALERT,
        hotel_id: HOTEL,
        rule_id: RULE,
        rule_version: 1,
        action_direction: "decrease",
        opened_at: "2026-09-17T10:00:00Z",
        resolved_at: null,
      },
    ],
    rule_repeat_alert_nights: [
      {
        alert_id: ALERT,
        hotel_id: HOTEL,
        rule_id: RULE,
        stay_date: "2026-11-14",
        fire_count: 3,
        last_fire_at: "2026-09-17T10:00:00Z",
        window_days: 30,
        window_bookings: 1,
        window_expected: 6,
        pickup_metric: null,
        pickup_threshold: null,
        pickup_window_days: null,
        pickup_net: null,
        room_types: [{ room_type_id: STD, fires: 3, limit: 1, limit_is_default: true, price: 12 }],
        choice: null,
        closed_at: null,
      },
      {
        alert_id: ALERT,
        hotel_id: HOTEL,
        rule_id: RULE,
        stay_date: "2026-11-16",
        fire_count: 4,
        last_fire_at: "2026-09-17T10:00:00Z",
        window_days: 30,
        window_bookings: 0,
        window_expected: 6,
        pickup_metric: null,
        pickup_threshold: null,
        pickup_window_days: null,
        pickup_net: null,
        room_types: [{ room_type_id: STD, fires: 4, limit: 1, limit_is_default: true, price: 10 }],
        choice: null,
        closed_at: null,
      },
    ],
    ...over,
  });
}

const post = (body: unknown, alertId = ALERT) =>
  POST(new Request("http://localhost/api/rules/alerts", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ alertId }),
  });

beforeEach(() => {
  state.role = "revenue_manager";
  state.hotelId = HOTEL;
  state.rpcCalls = [];
  state.events = [];
  state.fake = seed();
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/rules/alerts", () => {
  it("groups the hotel's open alerts with the nights still waiting", async () => {
    const body = await (await GET()).json();
    expect(body.can_manage).toBe(true);
    expect(body.simulation).toBe(false);
    expect(body.currency_symbol).toBe("$");
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].headline).toBe('"Slow-date rescue" has 3 to 4 cuts on each of 2 nights.');
    expect(body.alerts[0].nights.map((n: { stay_date: string }) => n.stay_date)).toEqual([
      "2026-11-14",
      "2026-11-16",
    ]);
    expect(body.alerts[0].nights[0].limit_is_default).toBe(true);
  });

  it("counts every night of every open alert, past any cap across the hotel (audit A14)", async () => {
    // Four cut rules: three filed on 388 nights each, one on 96 nights from
    // 300 days out, 1,260 nights in all, so the read takes two pages. One read
    // capped at 400 nights across the hotel cut the first ones short and left
    // the last ones out.
    const day = (i: number) => new Date(Date.UTC(2026, 9, 2) + i * 86_400_000).toISOString().slice(0, 10);
    const rules = [0, 1, 2, 3].map((k) => `00000000-0000-4000-8000-00000000003${k + 2}`);
    const alerts = [0, 1, 2, 3].map((k) => `00000000-0000-4000-8000-00000000004${k + 2}`);
    const nightRow = (k: number, i: number): Row => ({
      alert_id: alerts[k],
      hotel_id: HOTEL,
      rule_id: rules[k],
      stay_date: day(i),
      fire_count: 3,
      last_fire_at: "2026-09-17T10:00:00Z",
      window_days: null,
      window_bookings: null,
      window_expected: null,
      pickup_metric: null,
      pickup_threshold: null,
      pickup_window_days: null,
      pickup_net: null,
      room_types: [{ room_type_id: STD, fires: 3, limit: 80, limit_is_default: false, price: 100 }],
      choice: null,
      closed_at: null,
    });
    state.fake = seed({
      pricing_rules: rules.map((id, k) => ({ id, name: `Cut ${k + 1}` })),
      rule_repeat_alerts: alerts.map((id, k) => ({
        id,
        hotel_id: HOTEL,
        rule_id: rules[k],
        rule_version: 1,
        action_direction: "decrease",
        opened_at: `2026-09-1${k}T10:00:00Z`,
        resolved_at: null,
      })),
      rule_repeat_alert_nights: [
        ...Array.from({ length: 388 }, (_, i) => nightRow(0, i)),
        ...Array.from({ length: 388 }, (_, i) => nightRow(1, i)),
        ...Array.from({ length: 388 }, (_, i) => nightRow(2, i)),
        ...Array.from({ length: 96 }, (_, i) => nightRow(3, 300 + i)),
      ],
    });
    const body = await (await GET()).json();
    const cards = body.alerts as { rule_name: string; headline: string; night_count: number; nights: { stay_date: string }[] }[];
    expect(cards.map((c) => [c.rule_name, c.night_count, c.nights.length])).toEqual([
      ["Cut 1", 388, 30],
      ["Cut 2", 388, 30],
      ["Cut 3", 388, 30],
      ["Cut 4", 96, 30],
    ]);
    expect(cards[0].headline).toBe('"Cut 1" has 3 cuts on each of 388 nights.');
    expect(cards[3].nights[0].stay_date).toBe(day(300));
  });

  it("reads every open alert, up to one per rule of the 40 a property can have", async () => {
    const rules = Array.from({ length: 25 }, (_, k) => `00000000-0000-4000-8000-0000000005${String(k).padStart(2, "0")}`);
    const alerts = Array.from({ length: 25 }, (_, k) => `00000000-0000-4000-8000-0000000006${String(k).padStart(2, "0")}`);
    state.fake = seed({
      pricing_rules: rules.map((id, k) => ({ id, name: `Rule ${String(k).padStart(2, "0")}` })),
      rule_repeat_alerts: alerts.map((id, k) => ({
        id,
        hotel_id: HOTEL,
        rule_id: rules[k],
        rule_version: 1,
        action_direction: "increase",
        opened_at: `2026-09-17T10:${String(k).padStart(2, "0")}:00Z`,
        resolved_at: null,
      })),
      rule_repeat_alert_nights: alerts.map((id, k) => ({
        alert_id: id,
        hotel_id: HOTEL,
        rule_id: rules[k],
        stay_date: "2026-11-14",
        fire_count: 3,
        last_fire_at: "2026-09-17T10:00:00Z",
        room_types: [],
        choice: null,
        closed_at: null,
      })),
    });
    const body = await (await GET()).json();
    expect(body.alerts).toHaveLength(25);
  });

  it("names the whole window a rule that raises on a fast pace had to beat since its last raise", async () => {
    // The rule as it is now (an edit closes its nights): it raises on "at
    // least" Much Faster over a week, and its night counted 2 days.
    state.fake = seed({
      pricing_rules: [
        {
          id: RULE,
          name: "Hot-week surge",
          action_direction: "increase",
          rule_condition: [{ booking_speed_operator: "at_least", booking_speed_window_days: 7 }],
        },
      ],
      rule_repeat_alerts: [
        { id: ALERT, hotel_id: HOTEL, rule_id: RULE, rule_version: 1, action_direction: "increase", opened_at: "2026-09-17T10:00:00Z", resolved_at: null },
      ],
      rule_repeat_alert_nights: [
        {
          alert_id: ALERT,
          hotel_id: HOTEL,
          rule_id: RULE,
          stay_date: "2026-11-14",
          fire_count: 3,
          last_fire_at: "2026-09-17T10:00:00Z",
          window_days: 2,
          window_bookings: 6,
          window_expected: 1,
          pickup_metric: null,
          pickup_threshold: null,
          pickup_window_days: null,
          pickup_net: null,
          room_types: [{ room_type_id: STD, fires: 3, limit: 300, limit_is_default: false, price: 195 }],
          choice: null,
          closed_at: null,
        },
      ],
    });
    const body = await (await GET()).json();
    expect(body.alerts[0].nights[0].why).toEqual([
      "Since the raise before its latest one, by it or a stronger rule, 6 bookings came in. A night like this usually gets about 1 in a whole week.",
    ]);
  });

  it("shows a viewer the same alert and tells the banner they cannot answer", async () => {
    state.role = "viewer";
    state.fake = seed();
    const body = await (await GET()).json();
    expect(body.alerts).toHaveLength(1);
    expect(body.can_manage).toBe(false);
  });

  it("says nothing at all on a database without the alert tables", async () => {
    state.fake = seed();
    state.fake.tables.delete("rule_repeat_alerts");
    const missing = state.fake.from;
    state.fake.from = (t: string) =>
      t === "rule_repeat_alerts"
        ? ({
            select: () => state.fake.from(t),
            eq: () => state.fake.from(t),
            is: () => state.fake.from(t),
            order: () => state.fake.from(t),
            limit: () =>
              Promise.resolve({ data: null, error: { code: "42P01", message: "relation does not exist" } }),
          } as never)
        : missing(t);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).alerts).toEqual([]);
  });
});

describe("POST /api/rules/alerts/[alertId]", () => {
  it("records the answer for the nights named and hands back what is left", async () => {
    const res = await post({ choice: "stop", stay_dates: ["2026-11-14"] });
    expect(res.status).toBe(200);
    const call = state.rpcCalls.find((c) => c.name === "rule_repeat_alert_choose");
    expect(call?.args).toEqual({
      p_alert_id: ALERT,
      p_choice: "stop",
      p_stay_dates: ["2026-11-14"],
    });
    const body = await res.json();
    expect(body.alerts[0].nights.map((n: { stay_date: string }) => n.stay_date)).toEqual(["2026-11-16"]);
  });

  it("answers every waiting night when none are named", async () => {
    const res = await post({ choice: "keep_adjusting" });
    const call = state.rpcCalls.find((c) => c.name === "rule_repeat_alert_choose");
    expect(call?.args.p_stay_dates).toBeNull();
    expect((await res.json()).alerts).toEqual([]);
  });

  it("counts the answer once, with the rule and how many nights it settled", async () => {
    await post({ choice: "stop" });
    expect(state.events).toEqual([
      {
        event: "rule.repeat_alert_answered",
        properties: {
          rule_id: RULE,
          choice: "stop",
          nights: 2,
          all_nights: true,
          simulation: false,
        },
      },
    ]);
  });

  it("refuses anyone who cannot manage rules, before it writes anything", async () => {
    state.role = "viewer";
    state.fake = seed();
    const res = await post({ choice: "stop" });
    expect(res.status).toBe(403);
    expect(state.rpcCalls.some((c) => c.name === "rule_repeat_alert_choose")).toBe(false);
  });

  it("takes an answer back through the resume function, not by answering again", async () => {
    // "Let it run again" on the rules table. Answering keep_adjusting cleared
    // the stop but silenced those nights for good, which is not what the
    // owner asked for.
    await post({ choice: "stop", stay_dates: ["2026-11-14"] });
    state.rpcCalls.length = 0;
    const res = await post({ choice: "resume", stay_dates: ["2026-11-14"] });

    expect(res.status).toBe(200);
    expect(state.rpcCalls.some((c) => c.name === "rule_repeat_alert_choose")).toBe(false);
    expect(state.rpcCalls.find((c) => c.name === "rule_repeat_alert_resume")?.args).toEqual({
      p_alert_id: ALERT,
      p_stay_dates: ["2026-11-14"],
    });
    const night = (state.fake.tables.get("rule_repeat_alert_nights") ?? []).find(
      (n) => n.stay_date === "2026-11-14",
    );
    expect(night).toMatchObject({ choice: null, chosen_at: null, closed_reason: "resumed" });
    expect(state.events.at(-1)).toMatchObject({
      event: "rule.repeat_alert_answered",
      properties: expect.objectContaining({ choice: "resume", nights: 1, all_nights: false }),
    });
  });

  it("refuses an answer that is neither of the three, and a date that is not one", async () => {
    expect((await post({ choice: "maybe" })).status).toBe(400);
    expect((await post({ choice: "stop", stay_dates: ["2026-02-30"] })).status).toBe(400);
    expect((await post({ choice: "stop", stay_dates: [] })).status).toBe(400);
    expect(state.rpcCalls.some((c) => c.name === "rule_repeat_alert_choose")).toBe(false);
  });

  it("will not answer another property's alert", async () => {
    state.fake = seed({
      rule_repeat_alerts: [
        {
          id: ALERT,
          hotel_id: OTHER_HOTEL,
          rule_id: RULE,
          rule_version: 1,
          action_direction: "decrease",
          opened_at: "2026-09-17T10:00:00Z",
          resolved_at: null,
        },
      ],
    });
    const res = await post({ choice: "stop" });
    expect(res.status).toBe(404);
    expect(state.rpcCalls.some((c) => c.name === "rule_repeat_alert_choose")).toBe(false);
  });
});
