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

  function builder(table: string) {
    const filters: Filter[] = [];
    const rows = () => (tables.get(table) ?? []).filter((r) => matches(r, filters));
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), api),
      in: (c: string, v: unknown[]) => (filters.push(["in", c, v]), api),
      is: (c: string) => (filters.push(["isNull", c]), api),
      not: (c: string) => (filters.push(["notNull", c]), api),
      gte: () => api,
      lte: () => api,
      order: () => api,
      limit: () => api,
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
    expect(body.alerts[0].headline).toBe('"Slow-date rescue" has cut 2 nights, 3 to 4 times each.');
    expect(body.alerts[0].nights.map((n: { stay_date: string }) => n.stay_date)).toEqual([
      "2026-11-14",
      "2026-11-16",
    ]);
    expect(body.alerts[0].nights[0].limit_is_default).toBe(true);
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
