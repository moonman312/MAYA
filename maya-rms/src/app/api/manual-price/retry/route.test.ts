/**
 * Try again on a price the property system refused: the same door as typing
 * a price, one stamp on the failed row that the push reads as one more try,
 * one nudge, and never twice for one press.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTouchesColumn, fakeSupabase, missingColumn, type FakeRow } from "@/lib/engine/fake-supabase.test";
import { MAX_PUSH_ATTEMPTS } from "../../../../../supabase/functions/_shared/pms/push-failure";

const USER = "11111111-1111-4111-8111-111111111111";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-09-15T18:00:00Z");
const NIGHT = "2026-09-20";
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const OUTAGE = "Cloudbeds patchRate failed (503): Service Unavailable";
const VALUE_REFUSED = "Cloudbeds patchRate failed (400): Rate must be greater than 500";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  canManage: true,
  throttled: false,
  fake: null as unknown,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
// `after` needs a request scope; here the nudge just runs inline.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void fn(),
}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
    rpc: async () => ({ data: state.canManage, error: null }),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => (state.fake as ReturnType<typeof fakeSupabase>).client,
}));
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    enforceRateLimit: async (name: string, _subject: string, message?: string) =>
      state.throttled
        ? NextResponse.json({ error: `${name}: ${message}` }, { status: 429, headers: { "Retry-After": "60" } })
        : null,
  };
});

const { POST } = await import("./route");

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

const GOOD = { hotelId: HOTEL, roomTypeId: ROOM, date: NIGHT };

function post(body: unknown = GOOD) {
  return POST(
    new Request("http://localhost/api/manual-price/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const ledgerRow = () => (state.fake as ReturnType<typeof fakeSupabase>).tables.rate_updates[0];

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  state.userId = USER;
  state.canManage = true;
  state.throttled = false;
  state.fake = seed({ rate_updates: [failed(VALUE_REFUSED, 1)] });
  fetchSpy = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
  vi.stubEnv("CLOUDBEDS_CRON_SECRET", "shh");
  vi.stubEnv("MAYA_PRICING_HORIZON_DAYS", "60");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/manual-price/retry — doors", () => {
  it("401 when signed out, and nothing written", async () => {
    state.userId = null;
    expect((await post()).status).toBe(401);
    expect(ledgerRow().retry_requested_at).toBeNull();
  });

  it("403 below Revenue Manager, with the same sentence as typing a price", async () => {
    state.canManage = false;
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This needs Revenue Manager access or higher on this property." });
    expect(ledgerRow().retry_requested_at).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shares the manual price budget", async () => {
    state.throttled = true;
    const res = await post();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^manualPrice: /);
  });

  it("400 for a bad room type or date", async () => {
    expect((await post({ ...GOOD, roomTypeId: "nope" })).status).toBe(400);
    expect((await post({ ...GOOD, date: "2026-02-30" })).status).toBe(400);
    expect((await post({ ...GOOD, hotelId: "nope" })).status).toBe(400);
  });
});

describe("POST /api/manual-price/retry — one more try", () => {
  it("stamps a held price, nudges the sync once, and says it is retrying", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "retrying", alreadyRequested: false, nudged: "nudged" });
    expect(ledgerRow()).toMatchObject({ status: "failed", attempts: 1, retry_requested_at: NOW.toISOString() });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://proj.supabase.co/functions/v1/cloudbeds-scheduled-sync");
  });

  it("does the same for a price whose tries at that price are used", async () => {
    state.fake = seed({ rate_updates: [failed(OUTAGE, MAX_PUSH_ATTEMPTS)] });
    expect(await (await post()).json()).toMatchObject({ ok: true, state: "retrying", alreadyRequested: false });
    expect(ledgerRow().retry_requested_at).toBe(NOW.toISOString());
  });

  it("a second press while the first is still pending changes nothing and nudges nothing", async () => {
    await post();
    // A little later, the tick has not run yet: the stamp is still newer than the last try.
    vi.setSystemTime(new Date(NOW.getTime() + 30_000));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "retrying", alreadyRequested: true });
    expect(ledgerRow().retry_requested_at).toBe(NOW.toISOString());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a press after the try it asked for failed again is a new press", async () => {
    // Pressed, tried again a minute later and refused again: the stamp is older than the last try.
    state.fake = seed({ rate_updates: [failed(VALUE_REFUSED, 2, { retry_requested_at: minutesAgo(6), pushed_at: minutesAgo(5) })] });
    expect(await (await post()).json()).toMatchObject({ ok: true, alreadyRequested: false });
    expect(ledgerRow().retry_requested_at).toBe(NOW.toISOString());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("next_cycle, still stamped, when the sync cannot be nudged", async () => {
    vi.stubEnv("CLOUDBEDS_CRON_SECRET", "");
    expect(await (await post()).json()).toMatchObject({ ok: true, state: "retrying", nudged: "next_cycle" });
    expect(ledgerRow().retry_requested_at).toBe(NOW.toISOString());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/manual-price/retry — nothing to retry", () => {
  it("409 while MAYA is still retrying on its own, sending, or has sent it", async () => {
    state.fake = seed({ rate_updates: [failed(OUTAGE, 3)] });
    let res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "MAYA is already retrying this price.", state: "retrying" });

    state.fake = seed({ rate_updates: [failed("send in progress", 3)] });
    res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "MAYA is sending this price to Cloudbeds now.", state: "sending" });

    state.fake = seed({ rate_updates: [{ ...failed(OUTAGE, 1), status: "sent", error: null }] });
    res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This price has already been sent to Cloudbeds.", state: "sent" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("409 when the push has no row at this price, held it back, or nothing is sent at all", async () => {
    const cases: Record<string, FakeRow[]>[] = [
      { rate_updates: [] },
      { rate_updates: [{ ...failed("guardrail:below_floor", 0), status: "skipped" }] },
      { hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] },
      { pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "disconnected" }] },
    ];
    for (const rows of cases) {
      state.fake = seed({ rate_updates: [failed(VALUE_REFUSED, 1)], ...rows });
      const res = await post();
      expect(res.status, JSON.stringify(rows)).toBe(409);
      expect((await res.json()).error).toBe("There is nothing to retry for this night.");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("503 before the retry column exists, and nothing nudged", async () => {
    state.fake = seed(
      { rate_updates: [failed(VALUE_REFUSED, 1)] },
      {
        fault: (c) =>
          c.table === "rate_updates" &&
          ((c.op === "select" && c.columns.includes("retry_requested_at")) ||
            (c.op === "update" && callTouchesColumn(c, "retry_requested_at")))
            ? missingColumn("rate_updates", "retry_requested_at")
            : null,
      },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "This needs a database update first." });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("99_supabase_migration_manual_price_retry_v1.sql"))).toBe(true);
    errorSpy.mockRestore();
  });
});
