/**
 * /api/rules/stops — what the rules table reads to show that a rule the owner
 * stopped is doing nothing on some nights (GET), and its "Let it run again"
 * (POST).
 *
 * A "stop" belongs to the rule version it was given on, exactly as the engine
 * reads it (isStoppedOnNight), so an edited rule's old answers drop out here
 * too. A night that has passed is not counted in the chip, but it is still
 * one of the nights "Let it run again" takes the answer off. One click is one
 * call to rule_repeat_alert_resume_many over all the rule's alerts, and one
 * product event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter = ["eq", string, unknown] | ["in", string, unknown[]] | ["gte", string, string] | ["lt", string, string];

const HOTEL = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000a1";
const RULE = "00000000-0000-4000-8000-000000000031";
const OTHER_RULE = "00000000-0000-4000-8000-000000000032";
const ALERT = "00000000-0000-4000-8000-000000000041";
const ALERT2 = "00000000-0000-4000-8000-000000000042";

/** A night far enough ahead that the hotel's real clock cannot pass it. */
const AHEAD = (d: string) => `2099-${d}`;

/** Filters, orders and caps the way PostgREST does, so a read that leans on order() and limit() is tested as it runs. */
function fakeSupabase(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      const v = row[f[1]];
      if (f[0] === "eq") return v === f[2];
      if (f[0] === "in") return f[2].includes(v);
      if (f[0] === "lt") return String(v) < f[2];
      return String(v) >= f[2];
    });

  function builder(table: string) {
    const filters: Filter[] = [];
    const orders: { col: string; ascending: boolean }[] = [];
    let cap = Infinity;
    const rows = () => {
      const out = (tables.get(table) ?? []).filter((r) => matches(r, filters));
      out.sort((a, b) => {
        for (const o of orders) {
          const [x, y] = [String(a[o.col]), String(b[o.col])];
          if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
        }
        return 0;
      });
      return out.slice(0, cap);
    };
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), api),
      in: (c: string, v: unknown[]) => (filters.push(["in", c, v]), api),
      gte: (c: string, v: string) => (filters.push(["gte", c, v]), api),
      lt: (c: string, v: string) => (filters.push(["lt", c, v]), api),
      order: (c: string, o?: { ascending?: boolean }) => (orders.push({ col: c, ascending: o?.ascending !== false }), api),
      limit: (n: number) => ((cap = n), api),
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
  hotelId: HOTEL as string | null,
  role: "revenue_manager",
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
      if (name === "rule_repeat_alert_resume_many") {
        const ids = args.p_alert_ids as string[];
        const dates = args.p_stay_dates as string[];
        const nights = (state.fake.tables.get("rule_repeat_alert_nights") ?? []).filter(
          (n) => ids.includes(String(n.alert_id)) && n.choice != null && dates.includes(String(n.stay_date)),
        );
        for (const n of nights) {
          n.choice = null;
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
        state.events.push({ event: String(args.p_event), properties: args.p_properties as Record<string, unknown> });
      }
      return { data: null, error: null };
    },
  }),
}));

const { GET, POST, MAX_STOPPED_NIGHTS } = await import("./route");
const { hotelToday } = await import("@/lib/simulator");
const { addDays } = await import("@/lib/observations/calendar");

function night(over: Row = {}): Row {
  return {
    alert_id: ALERT,
    hotel_id: HOTEL,
    rule_id: RULE,
    rule_version: 1,
    stay_date: AHEAD("11-14"),
    choice: "stop",
    ...over,
  };
}

function seed(nights: Row[], rules: Row[] = [{ id: RULE, version: 1 }], alerts: Row[] = []) {
  return fakeSupabase({
    hotels: [{ id: HOTEL, timezone: "UTC" }],
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
    hotel_memberships: [{ hotel_id: HOTEL, user_id: USER, status: "active", role: state.role }],
    pricing_rules: rules,
    rule_repeat_alerts: alerts,
    rule_repeat_alert_nights: nights,
  });
}

beforeEach(() => {
  state.hotelId = HOTEL;
  state.role = "revenue_manager";
  state.rpcCalls = [];
  state.events = [];
  state.fake = seed([night()]);
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/rules/stops", () => {
  it("groups a rule's stopped nights, with the alerts they were filed under", async () => {
    state.fake = seed([
      night(),
      night({ stay_date: AHEAD("11-16") }),
      // A second episode of the same rule: both alerts have to be answered.
      night({ alert_id: ALERT2, stay_date: AHEAD("12-01") }),
      night({ rule_id: OTHER_RULE, alert_id: ALERT2, stay_date: AHEAD("11-14") }),
    ], [
      { id: RULE, version: 1 },
      { id: OTHER_RULE, version: 1 },
    ]);
    const body = await (await GET()).json();
    const upcoming = [AHEAD("11-14"), AHEAD("11-16"), AHEAD("12-01")];
    expect(body).toEqual([
      { rule_id: RULE, alert_ids: [ALERT, ALERT2], nights: upcoming, resume_nights: upcoming },
      { rule_id: OTHER_RULE, alert_ids: [ALERT2], nights: [AHEAD("11-14")], resume_nights: [AHEAD("11-14")] },
    ]);
  });

  it("leaves out a night nobody stopped and an older version's answer", async () => {
    state.fake = seed([
      night({ choice: "keep_adjusting" }),
      night({ choice: null }),
      night({ rule_version: 0, stay_date: AHEAD("11-20") }),
    ]);
    expect(await (await GET()).json()).toEqual([]);
  });

  it("counts only the nights still to come, and takes the answer off the passed ones too", async () => {
    // Stopped on a run of nights weeks ago, some of them now behind the
    // hotel. The chip says what the rule is doing nothing on; "Let it run
    // again" covers the lot, so the change log doesn't end up saying the
    // owner stopped the rule on the leftovers.
    state.fake = seed([
      night({ stay_date: "2000-01-01", alert_id: ALERT2 }),
      night({ stay_date: "2000-01-02", alert_id: ALERT2 }),
      night(),
    ]);
    expect(await (await GET()).json()).toEqual([
      {
        rule_id: RULE,
        alert_ids: [ALERT2, ALERT],
        nights: [AHEAD("11-14")],
        resume_nights: ["2000-01-01", "2000-01-02", AHEAD("11-14")],
      },
    ]);
  });

  it("says nothing about a rule whose stopped nights have all passed", async () => {
    state.fake = seed([night({ stay_date: "2000-01-01" })]);
    expect(await (await GET()).json()).toEqual([]);
  });

  it("says nothing at all when no rule is stopped", async () => {
    state.fake = seed([]);
    expect(await (await GET()).json()).toEqual([]);
  });

  it("keeps the nights nearest today when the hotel has more stopped nights than it reads", async () => {
    // Eight rules stopped on their next sixty nights: 480 rows, over the
    // hotel-wide cap. Read newest first, the cap kept the far end of the
    // season and dropped the nights about to happen, the ones the owner most
    // needs to see.
    const today = hotelToday("UTC");
    const nights: Row[] = [];
    const rules: Row[] = [];
    for (let r = 1; r <= 8; r++) {
      const ruleId = `00000000-0000-4000-8000-0000000001${String(r).padStart(2, "0")}`;
      rules.push({ id: ruleId, version: 1 });
      for (let d = 0; d < 60; d++) {
        nights.push(night({ rule_id: ruleId, alert_id: `00000000-0000-4000-8000-0000000002${String(r).padStart(2, "0")}`, stay_date: addDays(today, d) }));
      }
    }
    // And a stop from last week, on the first rule and an alert of its own.
    const OLD_ALERT = "00000000-0000-4000-8000-000000000299";
    nights.push(night({ rule_id: rules[0].id, alert_id: OLD_ALERT, stay_date: addDays(today, -7) }));
    state.fake = seed(nights, rules);

    const body = (await (await GET()).json()) as { rule_id: string; alert_ids: string[]; nights: string[]; resume_nights: string[] }[];
    const all = body.flatMap((b) => b.nights).sort();
    expect(all).toHaveLength(MAX_STOPPED_NIGHTS);
    // Every rule's next fifty nights are there, tonight first.
    for (const b of body) {
      expect(b.nights.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, d) => addDays(today, d)));
    }
    // The passed night is read on its own, so it takes none of the cap, and
    // "Let it run again" still takes the answer off it.
    const first = body.find((b) => b.rule_id === rules[0].id)!;
    expect(first.resume_nights[0]).toBe(addDays(today, -7));
    expect(first.resume_nights.slice(1)).toEqual(first.nights);
    expect(first.alert_ids).toEqual([OLD_ALERT, "00000000-0000-4000-8000-000000000201"]);
  });
});

describe("POST /api/rules/stops", () => {
  const alerts = [
    { id: ALERT, hotel_id: HOTEL, rule_id: RULE },
    { id: ALERT2, hotel_id: HOTEL, rule_id: RULE },
  ];
  const stopped = () =>
    seed(
      [
        night({ stay_date: "2000-01-01", alert_id: ALERT2 }),
        night(),
        night({ stay_date: AHEAD("11-16") }),
      ],
      [{ id: RULE, version: 1 }],
      alerts,
    );
  const post = (body: unknown) =>
    POST(new Request("http://localhost/api/rules/stops", { method: "POST", body: JSON.stringify(body) }));
  const resumes = () => state.rpcCalls.filter((c) => c.name.startsWith("rule_repeat_alert_resume"));

  it("lets the rule run again on every alert it was stopped under, in one call and one event", async () => {
    state.fake = stopped();
    const stops = await (await GET()).json();
    const res = await post({ alert_ids: stops[0].alert_ids, stay_dates: stops[0].resume_nights });

    expect(res.status).toBe(200);
    expect(resumes()).toEqual([
      {
        name: "rule_repeat_alert_resume_many",
        args: { p_alert_ids: [ALERT2, ALERT], p_stay_dates: ["2000-01-01", AHEAD("11-14"), AHEAD("11-16")] },
      },
    ]);
    expect(state.events).toEqual([
      {
        event: "rule.repeat_alert_answered",
        properties: { rule_id: RULE, choice: "resume", nights: 3, all_nights: false, simulation: false },
      },
    ]);
    // The chip's list, fresh: nothing is stopped any more.
    expect(await res.json()).toEqual([]);
  });

  it("refuses anyone who cannot manage rules, before it writes anything", async () => {
    state.role = "viewer";
    state.fake = stopped();
    const res = await post({ alert_ids: [ALERT], stay_dates: [AHEAD("11-14")] });
    expect(res.status).toBe(403);
    expect(resumes()).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("will not touch another property's alert, one it can't find, or two rules at once", async () => {
    state.fake = seed([night()], [{ id: RULE, version: 1 }], [
      { id: ALERT, hotel_id: HOTEL, rule_id: RULE },
      { id: ALERT2, hotel_id: "00000000-0000-4000-8000-000000000002", rule_id: RULE },
    ]);
    expect((await post({ alert_ids: [ALERT, ALERT2], stay_dates: [AHEAD("11-14")] })).status).toBe(404);
    expect((await post({ alert_ids: [ALERT, "00000000-0000-4000-8000-000000000099"], stay_dates: [AHEAD("11-14")] })).status).toBe(404);

    state.fake = seed([night()], [{ id: RULE, version: 1 }], [
      { id: ALERT, hotel_id: HOTEL, rule_id: RULE },
      { id: ALERT2, hotel_id: HOTEL, rule_id: OTHER_RULE },
    ]);
    expect((await post({ alert_ids: [ALERT, ALERT2], stay_dates: [AHEAD("11-14")] })).status).toBe(400);
    expect(resumes()).toEqual([]);
  });

  it("refuses a request that names no alerts, no nights or a date that is not one", async () => {
    state.fake = stopped();
    expect((await post({ stay_dates: [AHEAD("11-14")] })).status).toBe(400);
    expect((await post({ alert_ids: [], stay_dates: [AHEAD("11-14")] })).status).toBe(400);
    expect((await post({ alert_ids: ["not-an-id"], stay_dates: [AHEAD("11-14")] })).status).toBe(400);
    expect((await post({ alert_ids: [ALERT] })).status).toBe(400);
    expect((await post({ alert_ids: [ALERT], stay_dates: ["2026-02-30"] })).status).toBe(400);
    expect(resumes()).toEqual([]);
  });
});
