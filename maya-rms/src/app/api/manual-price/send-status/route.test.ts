/**
 * The send status behind the price editor's line: read from the ledger row
 * for the night and compared with the price the push would send, decided
 * with the push's own retry rules, so the count of tries left is the real
 * one. Any member may ask; only a manager may retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, missingColumn, missingRelation, type FakeRow } from "@/lib/engine/fake-supabase.test";
import {
  MAX_PUSH_ATTEMPTS,
  RETRY_AFTER_GIVING_UP_MS,
  SEND_IN_PROGRESS_MESSAGE,
} from "../../../../../supabase/functions/_shared/pms/push-failure";

const USER = "11111111-1111-4111-8111-111111111111";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const INCIDENT = "44444444-4444-4444-8444-444444444444";
const OTHER_INCIDENT = "55555555-5555-4555-8555-555555555555";

// Fixed clock: 2026-09-15 in the hotel's zone, with a 60-night window.
const NOW = new Date("2026-09-15T18:00:00Z");
const NIGHT = "2026-09-20";
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const OUTAGE = "Cloudbeds patchRate failed (503): Service Unavailable";
const VALUE_REFUSED = "Cloudbeds patchRate failed (400): Rate must be greater than 500";
const SCOPE_REFUSED = "Cloudbeds patchRate failed (403): scope required for this call was not granted";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  accessible: true,
  canManage: true,
  fake: null as unknown,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
    rpc: async (fn: string) => ({
      data: fn === "is_hotel_accessible" ? state.accessible : fn === "can_manage_hotel" ? state.canManage : null,
      error: null,
    }),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => (state.fake as ReturnType<typeof fakeSupabase>).client,
}));

const { GET } = await import("./route");

function seed(overrides: Record<string, FakeRow[]> = {}, opts: Parameters<typeof fakeSupabase>[1] = {}) {
  return fakeSupabase(
    {
      hotels: [{ id: HOTEL, timezone: "America/New_York", currency: "USD" }],
      hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
      pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected", reauthorized_at: null }],
      published_price: [{ hotel_id: HOTEL, room_type_id: ROOM, stay_date: NIGHT, price: 250 }],
      rate_updates: [],
      rate_push_incidents: [],
      rate_push_incident_cells: [],
      ...overrides,
    },
    opts,
  );
}

/** A failed ledger row for the night at the published price. */
function failed(error: string, attempts: number, more: FakeRow = {}): FakeRow {
  return {
    hotel_id: HOTEL,
    room_type_id: ROOM,
    stay_date: NIGHT,
    price: 250,
    status: "failed",
    error,
    attempts,
    pms_job_reference: null,
    pushed_at: minutesAgo(5),
    retry_requested_at: null,
    ...more,
  };
}

function get(query = `hotelId=${HOTEL}&roomTypeId=${ROOM}&date=${NIGHT}`) {
  return GET(new Request(`http://localhost/api/manual-price/send-status?${query}`));
}
const body = async (query?: string) => (await get(query)).json();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  state.userId = USER;
  state.accessible = true;
  state.canManage = true;
  state.fake = seed();
  vi.stubEnv("MAYA_PRICING_HORIZON_DAYS", "60");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/manual-price/send-status — doors", () => {
  it("401 when signed out", async () => {
    state.userId = null;
    expect((await get()).status).toBe(401);
  });

  it("400 for a bad hotel, room type or date", async () => {
    expect((await get(`hotelId=nope&roomTypeId=${ROOM}&date=${NIGHT}`)).status).toBe(400);
    expect((await get(`hotelId=${HOTEL}&roomTypeId=nope&date=${NIGHT}`)).status).toBe(400);
    expect((await get(`hotelId=${HOTEL}&roomTypeId=${ROOM}&date=2026-02-30`)).status).toBe(400);
  });

  it("403 for someone who is not on the property", async () => {
    state.accessible = false;
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "No access to that property." });
  });

  it("answers a viewer, who may not retry", async () => {
    state.canManage = false;
    state.fake = seed({ rate_updates: [failed(VALUE_REFUSED, 1)] });
    expect(await body()).toMatchObject({ applicable: true, state: "failed", canRetry: false });
  });
});

describe("GET /api/manual-price/send-status — states", () => {
  it("pending while the push has no row at this price, naming the system", async () => {
    expect(await body()).toMatchObject({
      applicable: true,
      state: "pending",
      retriesLeft: null,
      attempts: null,
      pmsType: "cloudbeds",
      pmsName: "Cloudbeds",
      canRetry: true,
      incidentId: null,
      maxAttempts: MAX_PUSH_ATTEMPTS,
    });
    // A row at another price is the same: the new price has not gone yet.
    state.fake = seed({ rate_updates: [{ ...failed(OUTAGE, 3), price: 240, status: "sent", error: null }] });
    expect((await body()).state).toBe("pending");
  });

  it("sent when the ledger says so at this price", async () => {
    state.fake = seed({ rate_updates: [{ ...failed(OUTAGE, 1), status: "sent", error: null }] });
    expect(await body()).toMatchObject({ state: "sent", retriesLeft: null, attempts: null, lastAttemptAt: null });
  });

  it("sending while the in-progress marker is on the row", async () => {
    state.fake = seed({ rate_updates: [failed(SEND_IN_PROGRESS_MESSAGE, 2)] });
    expect(await body()).toMatchObject({ state: "sending" });
  });

  it("retrying with the real count left, from the push's own constant", async () => {
    state.fake = seed({ rate_updates: [failed(OUTAGE, 3)] });
    expect(await body()).toMatchObject({
      state: "retrying",
      retriesLeft: MAX_PUSH_ATTEMPTS - 3,
      attempts: 3,
      lastAttemptAt: minutesAgo(5),
      retryRequested: false,
    });
    state.fake = seed({ rate_updates: [failed(OUTAGE, MAX_PUSH_ATTEMPTS - 1)] });
    expect(await body()).toMatchObject({ state: "retrying", retriesLeft: 1 });
  });

  it("failed once the tries at this price are used, and one more a day later", async () => {
    state.fake = seed({ rate_updates: [failed(OUTAGE, MAX_PUSH_ATTEMPTS)] });
    expect(await body()).toMatchObject({ state: "failed", retriesLeft: 0, attempts: MAX_PUSH_ATTEMPTS });
    state.fake = seed({
      rate_updates: [failed(OUTAGE, MAX_PUSH_ATTEMPTS, { pushed_at: new Date(NOW.getTime() - RETRY_AFTER_GIVING_UP_MS).toISOString() })],
    });
    expect(await body()).toMatchObject({ state: "retrying", retriesLeft: 1 });
  });

  it("failed from the first refusal for a cause that needs a person", async () => {
    state.fake = seed({ rate_updates: [failed(VALUE_REFUSED, 1)] });
    expect(await body()).toMatchObject({ state: "failed", retriesLeft: 0, attempts: 1 });
  });

  it("retrying once, after a reconnect newer than the last try, for a grant problem", async () => {
    state.fake = seed({
      pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected", reauthorized_at: minutesAgo(1) }],
      rate_updates: [failed(SCOPE_REFUSED, 1)],
    });
    expect(await body()).toMatchObject({ state: "retrying", retriesLeft: 1 });
  });

  it("retrying once, and says it was asked for, after Try again on a held or exhausted price", async () => {
    state.fake = seed({ rate_updates: [failed(VALUE_REFUSED, 1, { retry_requested_at: minutesAgo(1) })] });
    expect(await body()).toMatchObject({ state: "retrying", retriesLeft: 1, retryRequested: true });
    state.fake = seed({ rate_updates: [failed(OUTAGE, MAX_PUSH_ATTEMPTS, { retry_requested_at: minutesAgo(1) })] });
    expect(await body()).toMatchObject({ state: "retrying", retriesLeft: 1, retryRequested: true });
    // A press before the last try was spent by it.
    state.fake = seed({ rate_updates: [failed(VALUE_REFUSED, 1, { retry_requested_at: minutesAgo(30) })] });
    expect(await body()).toMatchObject({ state: "failed", retryRequested: false });
  });

  it("skipped for a night MAYA's own check held back", async () => {
    state.fake = seed({ rate_updates: [{ ...failed("guardrail:below_floor", 0), status: "skipped" }] });
    expect(await body()).toMatchObject({ state: "skipped", retriesLeft: null });
  });

  it("names the open sending problem the owner can see, and no other", async () => {
    const cells = [
      { incident_id: INCIDENT, hotel_id: HOTEL, room_type_id: ROOM, stay_date: NIGHT },
      { incident_id: OTHER_INCIDENT, hotel_id: HOTEL, room_type_id: ROOM, stay_date: NIGHT },
    ];
    const visible = { id: INCIDENT, hotel_id: HOTEL, admin_only: false, customer_visible_at: minutesAgo(10), resolved_at: null, opened_at: minutesAgo(60) };
    state.fake = seed({
      rate_updates: [failed(VALUE_REFUSED, 1)],
      rate_push_incident_cells: cells,
      rate_push_incidents: [visible, { ...visible, id: OTHER_INCIDENT, admin_only: true }],
    });
    expect((await body()).incidentId).toBe(INCIDENT);

    for (const hidden of [{ customer_visible_at: null }, { resolved_at: minutesAgo(1) }, { admin_only: true }]) {
      state.fake = seed({
        rate_updates: [failed(VALUE_REFUSED, 1)],
        rate_push_incident_cells: cells.slice(0, 1),
        rate_push_incidents: [{ ...visible, ...hidden }],
      });
      expect((await body()).incidentId, JSON.stringify(hidden)).toBeNull();
    }
    // Only a failed night is looked up.
    state.fake = seed({ rate_updates: [failed(OUTAGE, 2)], rate_push_incident_cells: cells, rate_push_incidents: [visible] });
    expect((await body()).incidentId).toBeNull();
  });

  it("answers before the retry column and the incident tables exist", async () => {
    state.fake = seed(
      { rate_updates: [failed(VALUE_REFUSED, 1)] },
      {
        fault: (c) => {
          if (c.table === "rate_updates" && c.op === "select" && c.columns.includes("retry_requested_at")) {
            return missingColumn("rate_updates", "retry_requested_at");
          }
          if (c.table.startsWith("rate_push_")) return missingRelation(c.table);
          return null;
        },
      },
    );
    expect(await body()).toMatchObject({ applicable: true, state: "failed", incidentId: null });
  });
});

describe("GET /api/manual-price/send-status — not applicable", () => {
  it("says so where nothing is sent: simulation, Mews, Disconnected, a stopped subscription", async () => {
    const cases: Record<string, Record<string, FakeRow[]>> = {
      simulation: { hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] },
      "no settings": { hotel_settings: [] },
      mews: { pms_connections: [{ hotel_id: HOTEL, pms_type: "mews", status: "connected" }] },
      disconnected: { pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "disconnected" }] },
      "no connection": { pms_connections: [] },
      billing: { hotel_subscriptions: [{ hotel_id: HOTEL, status: "unpaid" }] },
    };
    for (const [name, rows] of Object.entries(cases)) {
      state.fake = seed({ rate_updates: [failed(VALUE_REFUSED, 1)], ...rows });
      expect(await body(), name).toMatchObject({ applicable: false, state: null, canRetry: true });
    }
  });

  it("still applies on a connection that reads Error: the syncs keep trying it", async () => {
    state.fake = seed({
      pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "error" }],
      rate_updates: [failed(OUTAGE, 4)],
    });
    expect(await body()).toMatchObject({ applicable: true, state: "retrying", retriesLeft: MAX_PUSH_ATTEMPTS - 4 });
  });

  it("says so for a night that has passed or sits past the push window", async () => {
    // today + 59 = 2026-11-13 is the last night the push covers.
    for (const date of ["2026-09-14", "2026-11-14"]) {
      state.fake = seed({ rate_updates: [{ ...failed(VALUE_REFUSED, 1), stay_date: date }] });
      expect(await body(`hotelId=${HOTEL}&roomTypeId=${ROOM}&date=${date}`), date).toMatchObject({ applicable: false, pmsName: "Cloudbeds" });
    }
    state.fake = seed({ rate_updates: [{ ...failed(VALUE_REFUSED, 1), stay_date: "2026-11-13" }], published_price: [{ hotel_id: HOTEL, room_type_id: ROOM, stay_date: "2026-11-13", price: 250 }] });
    expect(await body(`hotelId=${HOTEL}&roomTypeId=${ROOM}&date=2026-11-13`)).toMatchObject({ applicable: true, state: "failed" });
  });
});
