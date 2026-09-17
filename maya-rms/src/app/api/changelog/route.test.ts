/**
 * Regression tests for the changelog route's failure behavior.
 *
 * An adversarial review found that any Supabase failure — a transient
 * PostgREST error, an unresolvable hotel — answered with the fabricated
 * demo changelog and HTTP 200, so a hotelier auditing what the system did
 * could be shown ten fully narrated price changes that never happened.
 * These tests pin the fix: a failed audit read is an error response with no
 * cycles in the body, a missing hotel is a 400, and the demo changelog is
 * reserved for installs with no Supabase configured at all.
 *
 * A minimal in-memory fake stands in for Supabase; next/headers and the
 * hotel/session helpers are mocked so the route runs outside a request
 * context.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase as sharedFake } from "@/lib/engine/fake-supabase.test";

type Row = Record<string, unknown>;

/** The engine's in-memory fake (paging, JSON-path selects) plus a session. */
function fakeSupabase(seed: Record<string, Row[]> = {}) {
  const failSelectFor = new Map<string, { message: string; code?: string }>();
  const fake = sharedFake(seed, {
    fault: (c) => (c.op === "select" ? (failSelectFor.get(c.table) ?? null) : null),
  });
  const client = Object.assign(fake.client, {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, failSelectFor, calls: fake.calls };
}

const HOTEL = "hotel-1";
const state = vi.hoisted(() => ({
  client: null as unknown,
  hotelId: "hotel-1" as string | null,
  configured: true,
  // The service-role client, when SUPABASE_SERVICE_ROLE_KEY is set.
  admin: null as unknown,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({
  isSupabaseConfigured: () => state.configured,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => state.admin != null,
  createAdminClient: () => state.admin,
}));
vi.mock("@/lib/hotel-context", () => ({
  resolveAccessibleHotelId: async () => state.hotelId,
}));

const { GET } = await import("./route");

function seedHealthyHotel() {
  return fakeSupabase({
    evaluation_audit: [
      {
        id: "audit-1",
        hotel_id: HOTEL,
        evaluation_run_id: "run-1",
        stay_date: "2026-08-01",
        room_type_id: "rt-1",
        evaluated_at: "2026-07-29T08:00:00Z",
        base_price: 180,
        final_price: 198,
        pre_clamp_price: 198,
        floor_price: 100,
        ceiling_price: 400,
        details: {
          application_order: ["rule:rule-1"],
          matched_ladder_rules: [
            {
              rule_id: "rule-1",
              action: { kind: "percent", direction: "increase", value: 10 },
              metrics: { occupancy: 0.82 },
            },
          ],
        },
      },
    ],
    hotels: [{ id: HOTEL, currency: "USD" }],
    room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Garden King" }],
    pricing_rules: [
      {
        id: "rule-1",
        hotel_id: HOTEL,
        name: "Busy week bump",
        action_type: "percent",
        action_direction: "increase",
        action_value: 10,
        is_pickup_rule: false,
        rule_condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 },
      },
    ],
    evaluation_run_log: [
      { hotel_id: HOTEL, evaluation_run_id: "run-1", evaluated_at: "2026-07-29T08:00:00Z" },
    ],
  });
}

describe("changelog route: failures are errors, never demo data", () => {
  it("returns an error response when the audit read fails, with no cycles in the body", async () => {
    const { client, failSelectFor } = seedHealthyHotel();
    failSelectFor.set("evaluation_audit", { message: "connection reset by peer" });
    state.client = client;
    state.hotelId = HOTEL;
    state.configured = true;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({
      error: "Something went wrong on our side. Try again in a moment.",
    });
    expect(Array.isArray(body)).toBe(false);
  });

  it("maps an RLS rejection on the audit read to a 403, not demo data", async () => {
    const { client, failSelectFor } = seedHealthyHotel();
    failSelectFor.set("evaluation_audit", {
      message: "permission denied for table evaluation_audit",
      code: "42501",
    });
    state.client = client;
    state.hotelId = HOTEL;
    state.configured = true;

    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You need manager access to do that." });
  });

  it("returns 400 when no hotel resolves for a signed-in user", async () => {
    const { client } = seedHealthyHotel();
    state.client = client;
    state.hotelId = null;
    state.configured = true;

    const res = await GET();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No hotel" });
  });

  it("builds cycles from real audit rows when the database is healthy", async () => {
    const { client } = seedHealthyHotel();
    state.client = client;
    state.hotelId = HOTEL;
    state.configured = true;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ has_changes: true, timestamp: "2026-07-29T08:00:00Z" });
    expect(body[0].changes[0]).toMatchObject({
      room_type: "Garden King",
      rule_name: "Busy week bump",
      original_rate: 180,
      new_rate: 198,
      change_pct: 10,
      evaluation_run_id: "run-1",
    });
  });

  // profiles is self-select only under RLS, so the caller's client would name
  // nobody but the caller. The names come off the service role instead.
  it("names a teammate who typed a manual price, via the service role", async () => {
    const manualRow = {
      id: "audit-2",
      hotel_id: HOTEL,
      evaluation_run_id: "run-2",
      stay_date: "2026-08-02",
      room_type_id: "rt-1",
      evaluated_at: "2026-07-30T08:00:00Z",
      base_price: 180,
      final_price: 180,
      pre_clamp_price: 180,
      floor_price: 100,
      ceiling_price: 400,
      details: {
        application_order: [],
        base_source: "manual",
        manual_override: { set_by: "user-2", set_at: "2026-07-30T07:59:00Z" },
      },
    };
    const withManual = fakeSupabase({
      evaluation_audit: [manualRow],
      hotels: [{ id: HOTEL, currency: "USD" }],
      room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Garden King" }],
      pricing_rules: [],
      evaluation_run_log: [
        { hotel_id: HOTEL, evaluation_run_id: "run-2", evaluated_at: "2026-07-30T08:00:00Z" },
      ],
      // What the caller's own client can see of profiles: themselves only.
      profiles: [{ id: "user-1", full_name: "Corey" }],
    });
    state.client = withManual.client;
    state.hotelId = HOTEL;
    state.configured = true;
    state.admin = fakeSupabase({
      profiles: [
        { id: "user-1", full_name: "Corey" },
        { id: "user-2", full_name: "Jake" },
      ],
    }).client;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body[0].changes[0].description).toBe("Jake set the base rate to $180.00.");

    // Without a service role the lookup stays on the caller's client, and a
    // teammate's price falls back to the anonymous line rather than failing.
    state.admin = null;
    const fallback = await (await GET()).json();
    expect(fallback[0].changes[0].description).toBe("A manager set the base rate to $180.00.");
  });

  it("puts the owner's answer to a repeating rule in the timeline, with their name", async () => {
    state.hotelId = HOTEL;
    state.configured = true;
    state.admin = fakeSupabase({ profiles: [{ id: "user-2", full_name: "Jake" }] }).client;
    // Two nights answered in one go, after the run the log shows.
    const nights = [
      {
        hotel_id: HOTEL,
        rule_id: "rule-1",
        stay_date: "2026-11-14",
        choice: "stop",
        chosen_at: "2026-07-29T09:00:00Z",
        chosen_by: "user-2",
      },
      {
        hotel_id: HOTEL,
        rule_id: "rule-1",
        stay_date: "2026-11-16",
        choice: "stop",
        chosen_at: "2026-07-29T09:00:00Z",
        chosen_by: "user-2",
      },
    ];
    const merged = fakeSupabase({
      evaluation_audit: [
        {
          id: "audit-1",
          hotel_id: HOTEL,
          evaluation_run_id: "run-1",
          stay_date: "2026-08-01",
          room_type_id: "rt-1",
          evaluated_at: "2026-07-29T08:00:00Z",
          base_price: 180,
          final_price: 198,
          pre_clamp_price: 198,
          floor_price: 100,
          ceiling_price: 400,
          details: {
            application_order: ["rule:rule-1"],
            matched_ladder_rules: [
              {
                rule_id: "rule-1",
                action: { kind: "percent", direction: "increase", value: 10 },
                metrics: { occupancy: 0.82 },
              },
            ],
          },
        },
      ],
      hotels: [{ id: HOTEL, currency: "USD" }],
      room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Garden King" }],
      pricing_rules: [
        {
          id: "rule-1",
          hotel_id: HOTEL,
          name: "Slow-date rescue",
          action_type: "percent",
          action_direction: "decrease",
          action_value: 15,
          is_pickup_rule: true,
        },
      ],
      evaluation_run_log: [
        { hotel_id: HOTEL, evaluation_run_id: "run-1", evaluated_at: "2026-07-29T08:00:00Z" },
      ],
      rule_repeat_alert_nights: nights,
    });
    state.client = merged.client;

    const body = await (await GET()).json();
    const answer = body.find((i: { kind?: string }) => i.kind === "rule_alert_choice");
    expect(answer).toMatchObject({
      rule_name: "Slow-date rescue",
      choice: "stop",
      nights: 2,
      timestamp: "2026-07-29T09:00:00Z",
    });
    expect(answer.title).toBe('Jake stopped "Slow-date rescue" on 2 nights. What it already changed stays.');
    // It sits above the run it happened after, and never replaces it.
    expect(body[0].kind).toBe("rule_alert_choice");
    expect(body.some((i: { has_changes?: boolean }) => i.has_changes === true)).toBe(true);
  });

  it("shows the runs even when the answers cannot be read", async () => {
    const { client, failSelectFor } = seedHealthyHotel();
    failSelectFor.set("rule_repeat_alert_nights", { message: "boom" });
    state.client = client;
    state.hotelId = HOTEL;
    state.configured = true;
    state.admin = null;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].has_changes).toBe(true);
  });

  it("still serves the demo changelog when Supabase is not configured", async () => {
    state.configured = false;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(10);
  });
});

describe("changelog route: a large property's runs", () => {
  function hotelWithRuns(rowsPerRun: (run: number) => number) {
    const audit: Row[] = [];
    const runLog: Row[] = [];
    let n = 0;
    for (let run = 0; run < 12; run++) {
      const at = new Date(Date.parse("2026-07-01T00:00:00Z") + run * 300_000).toISOString();
      runLog.push({ hotel_id: HOTEL, evaluation_run_id: `run-${run}`, evaluated_at: at, cells_changed: rowsPerRun(run) });
      for (let i = 0; i < rowsPerRun(run); i++) {
        n++;
        const kind = n % 5;
        const base = 100 + (n % 97);
        audit.push({
          id: `a${String(n).padStart(7, "0")}`,
          hotel_id: HOTEL,
          evaluation_run_id: `run-${run}`,
          stay_date: `2026-08-${String(1 + (i % 28)).padStart(2, "0")}`,
          room_type_id: "rt-1",
          evaluated_at: at,
          base_price: base,
          // Distinct moves so the ranking has no ties to break.
          final_price: kind === 0 ? base : base + (n % 1000) / 7 + i / 1000,
          pre_clamp_price: base,
          floor_price: 50,
          ceiling_price: 900,
          details: {
            application_order: kind === 1 ? ["ladder:rule-1"] : [],
            ...(kind === 2 ? { base_source: "manual", manual_override: { set_by: null, set_at: at } } : {}),
            matched_ladder_rules: [],
          },
        });
      }
    }
    return {
      evaluation_audit: audit,
      evaluation_run_log: runLog,
      hotels: [{ id: HOTEL, currency: "USD" }],
      room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Garden King" }],
      pricing_rules: [{ id: "rule-1", hotel_id: HOTEL, name: "Busy", action_type: "percent", action_direction: "increase", action_value: 5, is_pickup_rule: false, rule_condition: null }],
    };
  }

  async function getWith(seed: Record<string, Row[]>, opts: { noRunLog?: boolean } = {}) {
    const fake = fakeSupabase(seed);
    if (opts.noRunLog) {
      fake.failSelectFor.set("evaluation_run_log", { code: "PGRST205", message: "Could not find the table 'public.evaluation_run_log' in the schema cache" });
    }
    state.client = fake.client;
    state.hotelId = HOTEL;
    state.configured = true;
    state.admin = null;
    const res = await GET();
    expect(res.status).toBe(200);
    return { body: await res.json(), calls: fake.calls };
  }

  it("gives the old change log on a hotel whose history fits the old 600-row read", async () => {
    const seed = hotelWithRuns(() => 45);
    // 10 runs x 45 rows is under 600; the 12-run log is capped at 10 either way.
    const legacy = await getWith({ ...seed, evaluation_audit: seed.evaluation_audit.filter((r) => Number(String(r.evaluation_run_id).slice(4)) >= 2) }, { noRunLog: true });
    const current = await getWith(seed);
    expect(current.body).toEqual(legacy.body);
    expect(current.body).toHaveLength(10);
    expect(current.body[0].changes).toHaveLength(36); // 45 rows, one in five unchanged
  });

  it("still shows older runs' changes when the newest run alone wrote thousands of rows", async () => {
    const seed = hotelWithRuns((run) => (run === 11 ? 2500 : 30));
    const legacy = await getWith(seed, { noRunLog: true });
    const current = await getWith(seed);
    // The old read spent its 600 rows on the newest run.
    expect(legacy.body.filter((c: { has_changes: boolean }) => c.has_changes)).toHaveLength(1);
    expect(current.body).toHaveLength(10);
    expect(current.body.every((c: { has_changes: boolean }) => c.has_changes)).toBe(true);
    expect(current.body[1].changes.length).toBeGreaterThan(0);
    // Every audit read for a run is pinned to the run's timestamp, so it can
    // use (hotel_id, evaluated_at) instead of scanning the hotel's history.
    const runReads = current.calls.filter(
      (c) => c.table === "evaluation_audit" && c.filters.some((f) => f.col === "evaluation_run_id" || f.col === "id"),
    );
    expect(runReads.length).toBeGreaterThan(0);
    for (const c of runReads) expect(c.filters.some((f) => f.col === "evaluated_at" && f.kind === "eq")).toBe(true);
    // Details were read only for the entries shown.
    const fullReads = current.calls.filter((c) => c.table === "evaluation_audit" && c.columns.includes(" details"));
    for (const c of fullReads) {
      expect((c.filters.find((f) => f.col === "id")?.value as string[]).length).toBeLessThanOrEqual(40);
    }
  });
});

describe("changelog route: rates not reaching the PMS", () => {
  const incident = (over: Row): Row => ({
    id: "inc-visible",
    hotel_id: HOTEL,
    pms_type: "cloudbeds",
    cause: "rate_plan_not_updatable",
    known: true,
    severity: "critical",
    admin_only: false,
    opened_at: "2026-07-29T08:02:00Z",
    attempt_count: 25,
    attempts_stored: 25,
    customer_visible_at: "2026-07-29T08:02:00Z",
    resolved_at: null,
    resolution: null,
    ...over,
  });

  function liveHotel(extra: Record<string, Row[]> = {}) {
    const attempts: Row[] = [];
    for (let tick = 0; tick < 12; tick++) {
      for (const night of ["2026-08-01", "2026-08-02"]) {
        attempts.push({
          id: `att-${tick}-${night}`,
          incident_id: "inc-visible",
          hotel_id: HOTEL,
          attempted_at: new Date(Date.parse("2026-07-29T08:02:00Z") + tick * 300_000).toISOString(),
          stay_date: night,
          room_type_id: "rt-1",
          price: 198,
          phase: "guardrail",
          outcome: "skipped",
          http_status: null,
          message: "no rate target for room type",
        });
      }
    }
    attempts.push({
      id: "att-hidden",
      incident_id: "inc-hidden",
      hotel_id: HOTEL,
      attempted_at: "2026-07-29T08:03:00Z",
      stay_date: "2026-08-01",
      room_type_id: "rt-1",
      price: 198,
      phase: "send",
      outcome: "failed",
      http_status: 503,
      message: "Cloudbeds patchRate failed (503): Service Unavailable",
    });
    return fakeSupabase({
      ...pricingRuns(),
      hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
      rate_push_incidents: [
        incident({}),
        // Retrying quietly, not escalated: never sent to the owner.
        incident({ id: "inc-hidden", cause: "pms_unavailable", severity: "transient", customer_visible_at: null }),
        // A guardrail hold is MAYA's own business.
        incident({ id: "inc-guardrail", cause: "guardrail_stale_price", admin_only: true, customer_visible_at: null }),
      ],
      rate_push_incident_cells: [
        { incident_id: "inc-visible", hotel_id: HOTEL, room_type_id: "rt-1", stay_date: "2026-08-01", state: "open" },
        { incident_id: "inc-visible", hotel_id: HOTEL, room_type_id: "rt-1", stay_date: "2026-08-02", state: "open" },
      ],
      rate_push_attempts: attempts,
      ...extra,
    });
  }

  /** Two pricing runs five minutes apart, the first with one change. */
  function pricingRuns(): Record<string, Row[]> {
    return {
      evaluation_audit: [
        {
          id: "audit-1",
          hotel_id: HOTEL,
          evaluation_run_id: "run-1",
          stay_date: "2026-08-01",
          room_type_id: "rt-1",
          evaluated_at: "2026-07-29T08:00:00Z",
          base_price: 180,
          final_price: 198,
          pre_clamp_price: 198,
          floor_price: 100,
          ceiling_price: 400,
          details: { application_order: ["rule:rule-1"], matched_ladder_rules: [] },
        },
      ],
      hotels: [{ id: HOTEL, currency: "USD" }],
      room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Garden King" }],
      pricing_rules: [],
      evaluation_run_log: [
        { hotel_id: HOTEL, evaluation_run_id: "run-1", evaluated_at: "2026-07-29T08:00:00Z" },
        { hotel_id: HOTEL, evaluation_run_id: "run-2", evaluated_at: "2026-07-29T08:05:00Z" },
      ],
    };
  }

  async function get(client: unknown) {
    state.client = client;
    state.hotelId = HOTEL;
    state.configured = true;
    state.admin = null;
    const res = await GET();
    expect(res.status).toBe(200);
    return res.json();
  }

  it("adds each problem the owner should see as one condensed item, an ongoing one on top", async () => {
    const body = await get(liveHotel().client);

    expect(body.map((item: Row) => item.kind ?? item.timestamp)).toEqual(["push_problem", "2026-07-29T08:05:00Z", "2026-07-29T08:00:00Z"]);
    const problem = body[0];
    expect(problem).toMatchObject({
      id: "inc-visible",
      pms: "Cloudbeds",
      title: "Cloudbeds won't let MAYA change Garden King rates because that rate follows another rate plan",
      nights: 2,
      room_types: ["Garden King"],
      status: "ongoing",
      attempts: 25,
    });
    // 24 identical skips read as one line.
    expect(problem.retries).toEqual([
      expect.objectContaining({ count: 24, nights: 2, outcome: "skipped", first_at: "2026-07-29T08:02:00.000Z", last_at: "2026-07-29T08:57:00.000Z" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("inc-hidden");
    expect(JSON.stringify(body)).not.toContain("guardrail_stale_price");
  });

  it("leaves out problems that ended before the runs shown, reads tries per problem up to a cap, and counts only open nights", async () => {
    const extra: Row[] = [];
    for (let n = 0; n < 150; n++) {
      extra.push({
        id: `att-many-${String(n).padStart(3, "0")}`,
        incident_id: "inc-visible",
        hotel_id: HOTEL,
        attempted_at: new Date(Date.parse("2026-07-29T09:00:00Z") + n * 60_000).toISOString(),
        stay_date: "2026-08-02",
        room_type_id: "rt-1",
        price: 198,
        phase: "guardrail",
        outcome: "skipped",
        http_status: null,
        message: "no rate target for room type",
      });
    }
    const client = liveHotel({
      rate_push_incidents: [
        { id: "inc-visible", hotel_id: HOTEL, pms_type: "cloudbeds", cause: "rate_plan_not_updatable", known: true, severity: "critical", admin_only: false, opened_at: "2026-07-29T08:02:00Z", attempt_count: 174, attempts_stored: 174, customer_visible_at: "2026-07-29T08:02:00Z", resolved_at: null, resolution: null },
        // Ended within the runs shown.
        { id: "inc-ended", hotel_id: HOTEL, pms_type: "cloudbeds", cause: "value_rejected", known: true, severity: "critical", admin_only: false, opened_at: "2026-07-28T08:00:00Z", attempt_count: 2, attempts_stored: 2, customer_visible_at: "2026-07-28T08:00:00Z", resolved_at: "2026-07-29T08:03:00Z", resolution: "superseded" },
        // Ended months before them.
        { id: "inc-history", hotel_id: HOTEL, pms_type: "cloudbeds", cause: "value_rejected", known: true, severity: "critical", admin_only: false, opened_at: "2026-03-01T08:00:00Z", attempt_count: 2, attempts_stored: 2, customer_visible_at: "2026-03-01T08:00:00Z", resolved_at: "2026-03-01T09:00:00Z", resolution: "landed" },
      ],
      rate_push_incident_cells: [
        { incident_id: "inc-visible", hotel_id: HOTEL, room_type_id: "rt-1", stay_date: "2026-07-20", state: "stopped" },
        { incident_id: "inc-visible", hotel_id: HOTEL, room_type_id: "rt-1", stay_date: "2026-08-01", state: "landed" },
        { incident_id: "inc-visible", hotel_id: HOTEL, room_type_id: "rt-1", stay_date: "2026-08-02", state: "open" },
      ],
    });
    // 24 from liveHotel, and 150 more.
    await client.client.from("rate_push_attempts").insert(extra);

    const body = await get(client.client);

    expect(body.map((item: Row) => item.id ?? item.timestamp)).toEqual([
      "inc-visible",
      "2026-07-29T08:05:00Z",
      "inc-ended",
      "2026-07-29T08:00:00Z",
    ]);
    expect(body[0]).toMatchObject({ nights: 1, attempts: 174, retries_not_kept: 74 });
    const triesReads = client.calls.filter((c) => c.table === "rate_push_attempts" && c.op === "select");
    expect(triesReads.map((c) => c.filters.find((f) => f.col === "incident_id")?.value).sort()).toEqual(["inc-ended", "inc-visible"]);
  });

  it("shows none while the hotel is simulating", async () => {
    const body = await get(liveHotel({ hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] }).client);
    expect(body.some((item: Row) => item.kind === "push_problem")).toBe(false);
  });

  it("still serves the pricing runs when a problem read fails, and logs it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = liveHotel();
    fake.failSelectFor.set("rate_push_attempts", { code: "57014", message: "canceling statement due to statement timeout" });
    const body = await get(fake.client);
    expect(body.map((item: Row) => item.kind ?? item.timestamp)).toEqual(["2026-07-29T08:05:00Z", "2026-07-29T08:00:00Z"]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('"step":"push_problems"') && String(c[0]).includes("statement timeout"))).toBe(true);
    errors.mockRestore();
  });

  it("still serves the change log on a database without the incident tables", async () => {
    const fake = liveHotel();
    fake.failSelectFor.set("rate_push_incidents", {
      code: "PGRST205",
      message: "Could not find the table 'public.rate_push_incidents' in the schema cache",
    });
    const body = await get(fake.client);
    expect(body).toHaveLength(2);
  });
});
