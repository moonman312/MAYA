/**
 * GET /api/rules/:id/fires end to end on the in-memory fake, with
 * rule_fire_log and rule_fire_counts answered by their models: each fire's
 * compact row and what it opens to (room type, the price either side of its
 * run, why it fired, where the price went, what ended it later), worded for
 * the mode at its own time; the count equal to the rows the log pages
 * through; and the pages themselves.
 */
import { describe, expect, it, vi } from "vitest";
import { FakeRpcError, fakeSupabase as sharedFake, missingFunction, type FakeRow } from "@/lib/engine/fake-supabase.test";
import { ruleFireLogRpc } from "@/lib/rule-fire-log-rpc-model.test";
import type { RuleFireItem, RuleFireLogResponse } from "@/lib/rule-fire-log";

type Row = FakeRow;

function fake(seed: Record<string, Row[]>, opts: { noLog?: boolean; user?: boolean } = {}) {
  const f = sharedFake(seed, {
    rpc: (fn, args, tables) => {
      if (fn === "rule_fire_log" && opts.noLog) return new FakeRpcError(missingFunction("rule_fire_log"));
      const out = ruleFireLogRpc(fn, args, tables);
      return out === null ? undefined : out;
    },
  });
  return Object.assign(f.client, {
    auth: { getUser: async () => ({ data: { user: opts.user === false ? null : { id: "user-1" } } }) },
  });
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

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
/** A night far enough ahead to still be sent. */
const NIGHT = new Date(NOW + 60 * DAY).toISOString().slice(0, 10);
const NIGHT2 = new Date(NOW + 61 * DAY).toISOString().slice(0, 10);
/** Went live 10 days ago; simulating before that. */
const WENT_LIVE = ago(10);

const audit = (at: string, stay: string, finalPrice: number, details: Row = {}): Row => ({
  id: `a-${at}-${stay}`,
  hotel_id: HOTEL,
  evaluation_run_id: `run-${at}`,
  stay_date: stay,
  room_type_id: "rt-q",
  evaluated_at: at,
  base_price: 150,
  final_price: finalPrice,
  details: { application_order: [], ...details },
});

const activate = (id: string, at: string, stay: string, over: Row = {}): Row => ({
  id,
  hotel_id: HOTEL,
  rule_id: "rule-busy",
  rule_version: 2,
  stay_date: stay,
  room_type_id: "rt-q",
  transition: "activate",
  transitioned_at: at,
  metrics_snapshot: { occupancy: 0.82, dta: 30 },
  action_kind: "percent",
  action_direction: "increase",
  action_value: 10,
  ...over,
});

function seed(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    hotels: [{ id: HOTEL, currency: "USD", timezone: "America/New_York" }],
    room_types: [{ id: "rt-q", hotel_id: HOTEL, name: "Queen" }],
    pricing_rules: [
      {
        id: "rule-busy",
        hotel_id: HOTEL,
        name: "Busy nights",
        is_active: true,
        version: 2,
        rule_condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 },
        rule_signal_room_type: [{ room_type_id: "rt-q" }],
        rule_affected_room_type: [{ room_type_id: "rt-q" }],
      },
      {
        id: "rule-rush",
        hotel_id: HOTEL,
        name: "Rush",
        is_active: false,
        version: 1,
        rule_condition: { pickup_operator: "gt", pickup_threshold: 4, pickup_window_days: 3, pickup_metric: "room_nights" },
        rule_signal_room_type: [{ room_type_id: "rt-q" }],
        rule_affected_room_type: [{ room_type_id: "rt-q" }],
      },
    ],
    pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected" }],
    // Live now, as the mode history says.
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
    hotel_mode_history: [
      { hotel_id: HOTEL, since: "-infinity", simulated: true, recorded_at: ago(30) },
      { hotel_id: HOTEL, since: WENT_LIVE, simulated: false, recorded_at: WENT_LIVE },
    ],
    ladder_transition_event: [
      // Simulated: on, and off again two days later.
      activate("sim-1", ago(20), NIGHT2),
      activate("sim-1-off", ago(18), NIGHT2, { transition: "deactivate" }),
      // Live, and still the night's latest price.
      activate("live-1", ago(2), NIGHT),
    ],
    evaluation_audit: [
      audit(ago(25), NIGHT2, 150),
      audit(ago(20), NIGHT2, 165),
      audit(ago(18), NIGHT2, 150),
      audit(ago(40), NIGHT, 150),
      audit(ago(2), NIGHT, 160, { clamped_by: "ceiling" }),
    ],
    published_price: [{ hotel_id: HOTEL, stay_date: NIGHT, room_type_id: "rt-q", price: 160 }],
    rate_updates: [
      { hotel_id: HOTEL, room_type_id: "rt-q", stay_date: NIGHT, status: "sent", price: 160, error: null, attempts: 1, pms_job_reference: "j", pushed_at: ago(1.9) },
    ],
    ...extra,
  };
}

async function load(rule = "rule-busy", query = ""): Promise<{ status: number; body: RuleFireLogResponse & { error?: string } }> {
  const res = await GET(new Request(`http://maya.test/api/rules/${rule}/fires${query}`), { params: Promise.resolve({ id: rule }) });
  return { status: res.status, body: (await res.json()) as RuleFireLogResponse & { error?: string } };
}

const byId = (fires: RuleFireItem[], id: string) => fires.find((f) => f.id === id)!;

describe("GET /api/rules/:id/fires", () => {
  it("lists a rule's fires newest first, each a compact row in the property's time", async () => {
    state.client = fake(seed());
    state.admin = fake(seed());
    const { status, body } = await load();
    expect(status).toBe(200);
    expect(body.rule).toEqual({ id: "rule-busy", name: "Busy nights", enabled: true });
    expect(body.days).toBe(90);
    expect(body.fires.map((f) => f.id)).toEqual(["ladder:live-1", "ladder:sim-1"]);
    const live = byId(body.fires, "ladder:live-1");
    expect(live).toMatchObject({ stay_date: NIGHT, room_type: "Queen", adjustment: "+10%", mode: "live" });
    expect(live.night).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{1,2}$/);
    // In the property's time, with its zone: never mistaken for the viewer's clock.
    expect(live.when).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM) E[DS]T$/);
    expect(live.when_exact).toMatch(/E[DS]T$/);
  });

  it("says a simulated fire would have changed the price and that nothing was sent, after going live too", async () => {
    state.client = fake(seed());
    state.admin = fake(seed());
    const sim = byId((await load()).body.fires, "ladder:sim-1");
    expect(sim).toMatchObject({
      mode: "simulation",
      send_state: "simulated",
      // Live now: going live may have sent that price since, so "at the time".
      send_line: "Nothing was sent to Cloudbeds at the time.",
    });
    // A later run took it off again, so it isn't the night's price: nothing more.
    expect(sim.send_after_line).toBeUndefined();
    expect(sim.price_line).toMatch(/^Simulation: the price for (Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{1,2}, Queen would have gone from \$150\.00 to \$165\.00\.$/);
    expect(sim.later).toEqual([expect.stringMatching(/^Would have come off [A-Z][a-z]{2} \d{1,2}, /)]);
    expect(sim.why).toEqual(["It was 82% full, past the 70% mark you set."]);
  });

  it("says a live fire was sent only when the ledger shows it, with the ceiling that held it", async () => {
    state.client = fake(seed());
    state.admin = fake(seed());
    const live = byId((await load()).body.fires, "ladder:live-1");
    expect(live).toMatchObject({
      price_line: `Queen · stay ${NIGHT}: $150.00 up to $160.00 (+6.7%)`,
      price_note: "It stopped at your ceiling.",
      send_state: "sent",
      send_line: "Sent to Cloudbeds.",
      later: [],
    });
  });

  it("says waiting or couldn't be sent from the ledger, and nothing once a later run replaced the price", async () => {
    const pending = { rate_updates: [] };
    state.client = fake(seed());
    state.admin = fake(seed(pending));
    expect(byId((await load()).body.fires, "ladder:live-1").send_line).toBe("Waiting to be sent to Cloudbeds.");

    const failed = {
      rate_updates: [
        { hotel_id: HOTEL, room_type_id: "rt-q", stay_date: NIGHT, status: "failed", price: 160, error: "Cloudbeds patchRate failed (400): Rate must be greater than 500", attempts: 1, pms_job_reference: null, pushed_at: new Date(NOW - 60_000).toISOString() },
      ],
    };
    state.admin = fake(seed(failed));
    expect(byId((await load()).body.fires, "ladder:live-1").send_line).toBe("Couldn't be sent to Cloudbeds.");

    const replaced = { evaluation_audit: [...(seed().evaluation_audit ?? []), audit(ago(1), NIGHT, 170)] };
    state.client = fake(seed(replaced));
    state.admin = fake(seed(replaced));
    const live = byId((await load()).body.fires, "ladder:live-1");
    expect(live.price_line).toBe(`Queen · stay ${NIGHT}: $150.00 up to $160.00 (+6.7%)`);
    expect(live.send_line).toBeNull();
    expect(live.send_state).toBeNull();
  });

  it("says what going live did with a simulated fire's price the night still has", async () => {
    const stillSim = {
      ladder_transition_event: [activate("sim-2", ago(15), NIGHT2)],
      evaluation_audit: [audit(ago(25), NIGHT2, 150), audit(ago(15), NIGHT2, 165)],
      published_price: [{ hotel_id: HOTEL, stay_date: NIGHT2, room_type_id: "rt-q", price: 165 }],
    };
    const sentAfter = {
      rate_updates: [
        { hotel_id: HOTEL, room_type_id: "rt-q", stay_date: NIGHT2, status: "sent", price: 165, error: null, attempts: 1, pms_job_reference: "j", pushed_at: ago(9.9) },
      ],
    };
    state.client = fake(seed(stillSim));
    state.admin = fake(seed({ ...stillSim, ...sentAfter }));
    let [fire] = (await load()).body.fires;
    expect(fire).toMatchObject({
      mode: "simulation",
      send_line: "Nothing was sent to Cloudbeds at the time.",
      send_after_state: "sent",
      send_after_line: "Sent to Cloudbeds after you went live.",
    });
    // Not sent at that price yet: waiting, now that the property is live.
    state.admin = fake(seed({ ...stillSim, rate_updates: [] }));
    [fire] = (await load()).body.fires;
    expect(fire.send_after_line).toBe("Waiting to be sent to Cloudbeds now that you're live.");
    // Still simulating: nothing was sent, and nothing more to say.
    const simulating = { ...stillSim, hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] };
    state.client = fake(seed(simulating));
    state.admin = fake(seed({ ...simulating, ...sentAfter }));
    [fire] = (await load()).body.fires;
    expect(fire.send_line).toBe("Nothing was sent to Cloudbeds.");
    expect(fire.send_after_line).toBeUndefined();
  });

  it("never says waiting when the push can't send now", async () => {
    const pending = { rate_updates: [] };
    state.client = fake(seed());
    const gates: Record<string, Row[]>[] = [
      { hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] },
      { hotel_subscriptions: [{ hotel_id: HOTEL, status: "canceled" }] },
      { pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "disconnected" }] },
    ];
    for (const gate of gates) {
      state.admin = fake(seed({ ...pending, ...gate }));
      expect(byId((await load()).body.fires, "ladder:live-1").send_line).toBeNull();
    }
  });

  it("claims no send at all when the ledger can't be read, and says so plainly on Mews", async () => {
    state.client = fake(seed());
    state.admin = null;
    const fires = (await load()).body.fires;
    expect(byId(fires, "ladder:live-1").send_line).toBeNull();
    expect(byId(fires, "ladder:sim-1").send_line).toBe("Nothing was sent to Cloudbeds at the time.");

    const mews = { pms_connections: [{ hotel_id: HOTEL, pms_type: "mews", status: "connected" }] };
    state.client = fake(seed(mews));
    state.admin = fake(seed(mews));
    const onMews = (await load()).body.fires;
    expect(byId(onMews, "ladder:live-1").send_line).toBe("Nothing was sent to Mews. MAYA doesn't send prices there yet.");
    expect(byId(onMews, "ladder:sim-1").send_line).toBe("Nothing was sent to Mews.");
  });

  it("reads as the log always did with no mode history: no simulation words, no send claims", async () => {
    const noHistory = { hotel_mode_history: [] };
    state.client = fake(seed(noHistory));
    state.admin = fake(seed(noHistory));
    const sim = byId((await load()).body.fires, "ladder:sim-1");
    expect(sim.mode).toBeUndefined();
    expect(sim.price_line).toBe(`Queen · stay ${NIGHT2}: $150.00 up to $165.00 (+10%)`);
    expect(sim.send_line).toBeNull();
    expect(sim.later).toEqual([expect.stringMatching(/^Came off /)]);
  });

  it("shows only the numbers when the rule has been edited since, never its marks now", async () => {
    const edited = { ladder_transition_event: [activate("old", ago(3), NIGHT, { rule_version: 1 })] };
    state.client = fake(seed(edited));
    state.admin = fake(seed(edited));
    const [fire] = (await load()).body.fires;
    expect(fire.why).toEqual(["It was 82% full.", "It had 30 days to go.", "The rule has been edited since."]);
  });

  it("explains a pickup fire from its run's numbers, or its own when the run's row is gone, and what ended it", async () => {
    const pickups = {
      pickup_event: [
        {
          id: "p1",
          hotel_id: HOTEL,
          rule_id: "rule-rush",
          rule_version: 1,
          stay_date: NIGHT,
          affected_room_type_id: "rt-q",
          applied_at: ago(5),
          retired_at: ago(4),
          retired_reason: "bookings_cancelled",
          action_kind: "fixed",
          action_direction: "increase",
          action_value: 15,
          fire_seq: 1,
          signal_booked_units_start: 2,
          signal_booked_units_end: 8,
        },
        {
          id: "p2",
          hotel_id: HOTEL,
          rule_id: "rule-rush",
          rule_version: 1,
          stay_date: NIGHT,
          affected_room_type_id: "rt-q",
          applied_at: ago(3),
          retired_at: null,
          retired_reason: null,
          action_kind: "fixed",
          action_direction: "increase",
          action_value: 15,
          fire_seq: 2,
          signal_booked_units_start: 8,
          signal_booked_units_end: 14,
        },
        // The same-run bug's row: never listed, never counted.
        { id: "p3", hotel_id: HOTEL, rule_id: "rule-rush", stay_date: NIGHT, affected_room_type_id: "rt-q", applied_at: ago(3), retired_at: ago(3), retired_reason: "self_cancelled", action_kind: "fixed", action_direction: "increase", action_value: 15 },
      ],
      evaluation_audit: [
        audit(ago(40), NIGHT, 150),
        audit(ago(5), NIGHT, 165, { pickup_candidates: [{ rule_id: "rule-rush", outcome: "won", metrics: { occupancy: 0.5, dta: 50, net_pickup_units: 6 } }] }),
      ],
      rule_repeat_alert_nights: [{ hotel_id: HOTEL, rule_id: "rule-rush", stay_date: NIGHT, choice: "stop", chosen_at: ago(4.5) }],
    };
    state.client = fake(seed(pickups));
    state.admin = fake(seed(pickups));
    const { body } = await load("rule-rush");
    expect(body.rule.enabled).toBe(false);
    expect(body.total).toBe(2);
    expect(body.fires.map((f) => f.id)).toEqual(["pickup:p2", "pickup:p1"]);
    const [second, first] = body.fires;
    expect(first.adjustment).toBe("+$15");
    expect(first.why).toEqual(["6 bookings arrived that day and the 2 days before, past the 4-booking mark you set."]);
    expect(first.price_line).toBe(`Queen · stay ${NIGHT}: $150.00 up to $165.00 (+10%)`);
    expect(first.later).toEqual([
      expect.stringMatching(/^Told to stop on this night /),
      expect.stringMatching(/^Came off .*: bookings behind it cancelled\.$/),
    ]);
    // No audit row for its run: only what the fire kept, and no price.
    expect(second.why).toEqual(["6 bookings arrived in its count."]);
    expect(second.price_line).toBeNull();
    expect(second.send_line).toBeNull();
  });

  it("pages back through the 90 days, the count equal to every row the pages hold", async () => {
    const run = ago(6);
    const many = {
      ladder_transition_event: [
        ...Array.from({ length: 30 }, (_, i) =>
          activate(`many-${String(i).padStart(2, "0")}`, run, new Date(NOW + (70 + i) * DAY).toISOString().slice(0, 10)),
        ),
        activate("too-old", ago(91), NIGHT),
        activate("off", ago(5), NIGHT, { transition: "deactivate" }),
      ],
    };
    state.client = fake(seed(many));
    state.admin = fake(seed(many));
    const first = await load();
    expect(first.body.total).toBe(30);
    expect(first.body.fires).toHaveLength(25);
    expect(first.body.older).toEqual(expect.any(String));
    const second = await load("rule-busy", `?older=${first.body.older}`);
    expect(second.status).toBe(200);
    expect(second.body.total).toBeNull();
    expect(second.body.fires).toHaveLength(5);
    expect(second.body.older).toBeNull();
    const ids = [...first.body.fires, ...second.body.fires].map((f) => f.id);
    expect(new Set(ids).size).toBe(30);
    expect(ids).not.toContain("ladder:too-old");
    // One run's fires come in night order across the two pages.
    const nights = [...first.body.fires, ...second.body.fires].map((f) => f.stay_date);
    expect(nights).toEqual([...nights].sort());
  });

  it("refuses a page link it didn't hand out, a rule not on the property, and a signed-out caller", async () => {
    state.client = fake(seed());
    state.admin = fake(seed());
    expect((await load("rule-busy", "?older=not-a-cursor")).status).toBe(400);
    expect((await load("rule-elsewhere")).status).toBe(404);
    state.client = fake(seed(), { user: false });
    expect((await load()).status).toBe(401);
  });

  it("says it isn't ready rather than inventing a log before the migration", async () => {
    state.client = fake(seed(), { noLog: true });
    state.admin = fake(seed());
    const { status, body } = await load();
    expect(status).toBe(503);
    expect(body.error).toMatch(/isn't ready yet/);
  });
});
