/**
 * GET /api/changelog, end to end on the in-memory fake: a run made while the
 * property was simulating says what would have happened and that nothing was
 * sent, and stays that way after the property goes live; a live run says a
 * price was sent only when the send ledger shows it; an answer given while
 * simulating calls the rule's changes simulated; and without the history
 * table the log reads as it always did.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase as sharedFake, missingRelation } from "@/lib/engine/fake-supabase.test";

type Row = Record<string, unknown>;

function fake(seed: Record<string, Row[]>, opts: { missing?: string[] } = {}) {
  const f = sharedFake(seed, {
    fault: (c) => (c.op === "select" && opts.missing?.includes(c.table) ? missingRelation(c.table) : null),
  });
  return Object.assign(f.client, { auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } });
}

const HOTEL = "hotel-1";
const state = vi.hoisted(() => ({ client: null as unknown, admin: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => state.admin != null, createAdminClient: () => state.admin }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));

const { GET } = await import("./route");

/** Went live on Sep 20; the night is far enough ahead to still be sent. */
const WENT_LIVE = "2026-09-20T10:00:00Z";
const SIM_RUN = "2026-09-18T08:00:00Z";
const LIVE_RUN = "2026-09-22T08:00:00Z";
const NIGHT = "2027-03-12";

const audit = (id: string, runId: string, at: string, over: Row = {}): Row => ({
  id,
  hotel_id: HOTEL,
  evaluation_run_id: runId,
  stay_date: NIGHT,
  room_type_id: "rt-1",
  evaluated_at: at,
  base_price: 150,
  final_price: 165,
  pre_clamp_price: 165,
  floor_price: 80,
  ceiling_price: 400,
  details: {
    application_order: ["ladder:rule-1"],
    matched_ladder_rules: [
      { rule_id: "rule-1", rule_version: 1, transition: "activate", action: { kind: "percent", direction: "increase", value: 10 }, metrics: { occupancy: 0.82 } },
    ],
  },
  ...over,
});

function seed(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    evaluation_audit: [
      audit("a-live", "run-live", LIVE_RUN, { stay_date: NIGHT }),
      audit("a-sim", "run-sim", SIM_RUN, { stay_date: "2027-03-13" }),
    ],
    evaluation_run_log: [
      { hotel_id: HOTEL, evaluation_run_id: "run-live", evaluated_at: LIVE_RUN, cells_changed: 1 },
      { hotel_id: HOTEL, evaluation_run_id: "run-sim", evaluated_at: SIM_RUN, cells_changed: 1 },
    ],
    hotels: [{ id: HOTEL, currency: "USD", timezone: "UTC" }],
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
    room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Queen" }],
    pricing_rules: [
      {
        id: "rule-1",
        hotel_id: HOTEL,
        name: "Busy nights",
        action_type: "percent",
        action_direction: "increase",
        action_value: 10,
        is_pickup_rule: false,
        rule_condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 },
      },
    ],
    pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected" }],
    hotel_mode_history: [
      { hotel_id: HOTEL, since: "-infinity", simulated: true, recorded_at: "2026-09-30T00:00:00Z" },
      { hotel_id: HOTEL, since: WENT_LIVE, simulated: false, recorded_at: WENT_LIVE },
    ],
    published_price: [{ hotel_id: HOTEL, stay_date: NIGHT, room_type_id: "rt-1", price: 165 }],
    rate_updates: [
      {
        hotel_id: HOTEL,
        room_type_id: "rt-1",
        stay_date: NIGHT,
        status: "sent",
        price: 165,
        error: null,
        attempts: 1,
        pms_job_reference: "job-1",
        pushed_at: "2026-09-22T08:05:00Z",
      },
    ],
    ...extra,
  };
}

type Entry = { headline?: string; send_line?: string; narrative?: string[]; mode?: string };
type Item = { kind?: string; changes?: Entry[]; mode?: string; title?: string };

async function load(): Promise<Item[]> {
  const res = await GET();
  const body = (await res.json()) as Item[];
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

describe("GET /api/changelog: simulation and live, told honestly", () => {
  it("words a simulated run as what would have happened, after the property went live too", async () => {
    state.client = fake(seed());
    state.admin = fake(seed());
    const [live, sim] = (await load()).filter((i) => i.changes);
    expect(sim.mode).toBe("simulation");
    expect(sim.changes?.[0]).toMatchObject({
      mode: "simulation",
      headline: "Simulation: the price for Sat Mar 13, Queen would have gone from $150.00 to $165.00.",
      send_line: "Nothing was sent to Cloudbeds.",
    });
    expect(sim.changes?.[0].narrative?.[0]).toBe('"Busy nights" would have raised this night 10%, from $150.00 to $165.00.');
    expect(live.mode).toBe("live");
    expect(live.changes?.[0]).toMatchObject({
      mode: "live",
      headline: "Queen · stay 2027-03-12: $150.00 up to $165.00 (+10%)",
      send_line: "Sent to Cloudbeds.",
    });
  });

  it("says a live price is waiting until the ledger shows the send", async () => {
    state.client = fake(seed());
    state.admin = fake(seed({ rate_updates: [] }));
    const [live] = (await load()).filter((i) => i.changes);
    expect(live.changes?.[0].send_line).toBe("Waiting to be sent to Cloudbeds.");
  });

  it("claims no send at all when the ledger can't be read", async () => {
    state.client = fake(seed());
    state.admin = null;
    const [live, sim] = (await load()).filter((i) => i.changes);
    expect(live.changes?.[0].send_line).toBeUndefined();
    // Simulation needs no ledger to say nothing was sent.
    expect(sim.changes?.[0].send_line).toBe("Nothing was sent to Cloudbeds.");
  });

  it("calls a rule's changes simulated in an answer given while simulating", async () => {
    const answers = {
      rule_repeat_alert_nights: [
        { hotel_id: HOTEL, rule_id: "rule-1", stay_date: "2027-03-13", choice: "stop", chosen_at: "2026-09-19T08:00:00Z", chosen_by: null, resumed_at: null, resumed_by: null },
      ],
    };
    state.client = fake(seed(answers));
    state.admin = fake(seed(answers));
    const answer = (await load()).find((i) => i.kind === "rule_alert_choice");
    expect(answer).toMatchObject({
      mode: "simulation",
      title: 'A manager stopped "Busy nights" on Sat, Mar 13 2027. Its simulated changes so far stay, unless cancellations mean the rule is no longer true.',
    });
  });

  it("reads as it always did on a database without the history yet", async () => {
    state.client = fake(seed(), { missing: ["hotel_mode_history"] });
    state.admin = fake(seed());
    const [live, sim] = (await load()).filter((i) => i.changes);
    for (const run of [live, sim]) {
      expect(run.mode).toBeUndefined();
      expect(run.changes?.[0].mode).toBeUndefined();
      expect(run.changes?.[0].send_line).toBeUndefined();
      expect(run.changes?.[0].narrative?.[0]).toBe('"Busy nights" raised this night 10%, from $150.00 to $165.00.');
    }
  });
});
