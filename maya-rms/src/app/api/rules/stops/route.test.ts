/**
 * GET /api/rules/stops — what the rules table reads to show that a rule the
 * owner stopped is doing nothing on some nights.
 *
 * A "stop" belongs to the rule version it was given on and to nights still to
 * come, exactly as the engine reads it (isStoppedOnNight), so an edited rule
 * and a night that has passed drop out here too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter = ["eq", string, unknown] | ["in", string, unknown[]] | ["gte", string, string];

const HOTEL = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000a1";
const RULE = "00000000-0000-4000-8000-000000000031";
const OTHER_RULE = "00000000-0000-4000-8000-000000000032";
const ALERT = "00000000-0000-4000-8000-000000000041";
const ALERT2 = "00000000-0000-4000-8000-000000000042";

/** A night far enough ahead that the hotel's real clock cannot pass it. */
const AHEAD = (d: string) => `2099-${d}`;

function fakeSupabase(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      const v = row[f[1]];
      if (f[0] === "eq") return v === f[2];
      if (f[0] === "in") return f[2].includes(v);
      return String(v) >= f[2];
    });

  function builder(table: string) {
    const filters: Filter[] = [];
    const rows = () => (tables.get(table) ?? []).filter((r) => matches(r, filters));
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), api),
      in: (c: string, v: unknown[]) => (filters.push(["in", c, v]), api),
      gte: (c: string, v: string) => (filters.push(["gte", c, v]), api),
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

const state = { fake: fakeSupabase({}), hotelId: HOTEL as string | null };

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => state.hotelId }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    rpc: async () => ({ data: null, error: null }),
    from: (t: string) => state.fake.from(t),
  }),
}));

const { GET } = await import("./route");

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

function seed(nights: Row[], rules: Row[] = [{ id: RULE, version: 1 }]) {
  return fakeSupabase({
    hotels: [{ id: HOTEL, timezone: "UTC" }],
    pricing_rules: rules,
    rule_repeat_alert_nights: nights,
  });
}

beforeEach(() => {
  state.hotelId = HOTEL;
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
    expect(body).toEqual([
      { rule_id: RULE, alert_ids: [ALERT, ALERT2], nights: [AHEAD("11-14"), AHEAD("11-16"), AHEAD("12-01")] },
      { rule_id: OTHER_RULE, alert_ids: [ALERT2], nights: [AHEAD("11-14")] },
    ]);
  });

  it("leaves out a night nobody stopped, one that has passed, and an older version's answer", async () => {
    state.fake = seed([
      night({ choice: "keep_adjusting" }),
      night({ choice: null }),
      night({ stay_date: "2000-01-01" }),
      night({ rule_version: 0, stay_date: AHEAD("11-20") }),
    ]);
    expect(await (await GET()).json()).toEqual([]);
  });

  it("says nothing at all when no rule is stopped", async () => {
    state.fake = seed([]);
    expect(await (await GET()).json()).toEqual([]);
  });
});
