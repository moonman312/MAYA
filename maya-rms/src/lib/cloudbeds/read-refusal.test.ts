/**
 * What a refused read does to the connection.
 *
 * A Disconnected connection stops reading, pricing and sending, and only a
 * General Manager signing in to Cloudbeds again brings it back. So one
 * refusal must not be enough: the read gets a new token and a second try,
 * and an error page from something in front of Cloudbeds is an outage.
 *
 * Everything below the network is real here: the sync, the Cloudbeds client,
 * the token refresh. Only `fetch`, the pacing between calls and the database
 * are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({
  acquire: vi.fn(async () => {}),
  record: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/pms/rate-limit.ts", () => limiter);
vi.mock("../../../supabase/functions/_shared/cloudbeds/request-log.ts", () => ({
  installCloudbedsRequestLogging: vi.fn(),
}));

import { runCloudbedsSyncForHotel } from "../../../supabase/functions/_shared/cloudbeds/sync-hotel";
import { REFUSED_RUNS_BEFORE_DISCONNECT } from "../../../supabase/functions/_shared/pms/connection-health";
import { type FakeRow, fakeSupabase } from "../engine/fake-supabase.test";
import { type Json, rateDetailsBooking as booking } from "./__fixtures__/rate-details";

const NOW = new Date("2026-08-04T10:00:00Z");
const API = "https://hotels.cloudbeds.com/api/v1.2";
const TOKEN_URL = "https://hotels.cloudbeds.com/api/v1.3/access_token";

type Call = { method: string; token: string; page: number };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A firewall's block page: a 403 that Cloudbeds never wrote. */
function blockPage(status = 403): Response {
  return new Response("<!DOCTYPE html><html><head><title>Attention Required</title></head><body>Access denied</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

/** Cloudbeds refusing a token, in its own format. The wording is a guess; the shape is not. */
const refusedToken = (status = 401) => json(status, { success: false, message: "Access token is invalid or has expired." });

const NOT_CONNECTED = json(200, {
  success: false,
  message: "Application is not available to be connected. Reach out to Modern Hospitality Solutions support for any questions.",
});

const BOOK: Json[] = [
  booking({ id: "5538214799001", status: "confirmed", checkIn: "2026-08-15", checkOut: "2026-08-17", nightly: 240 }),
];

/** What Cloudbeds answers a token it accepts. */
function goodAnswer(method: string, book: Json[], page: number): Response {
  if (method === "getRoomTypes") {
    return json(200, { success: true, data: [{ roomTypeID: "RT1", roomTypeName: "King", roomTypeUnits: 8 }] });
  }
  if (method === "getTaxesAndFees") {
    return json(200, { success: false, message: "Scope required for this call was not granted by property." });
  }
  if (method === "getReservationsWithRateDetails") {
    const start = (page - 1) * 100;
    return json(200, { success: true, data: book.slice(start, start + 100), count: Math.min(100, book.length - start), total: book.length });
  }
  return json(200, { success: true, data: [] });
}

function world(opts: {
  /** Cloudbeds' answer to a call; null answers it as a token it accepts. */
  api: (call: Call, calls: Call[]) => Response | null;
  /** The token endpoint. Default: mints cbat_2, cbat_3, ... */
  tokens?: (n: number) => Response;
  book?: Json[];
  connection?: FakeRow;
}) {
  const vault: { secret: Record<string, unknown> } = {
    secret: {
      accessToken: "cbat_1",
      refreshToken: "refresh_1",
      tokenType: "Bearer",
      scope: "read:reservation read:rate write:rate",
      // An hour of life left: nothing about it says it needs a refresh.
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      propertyId: "prop-1",
    },
  };
  let countedAtSync: unknown = undefined;
  const db = fakeSupabase(
    {
      hotels: [{ id: "hotel-1", total_rooms_per_type: 10 }],
      pms_connections: [
        { id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", status: "connected", base_url: null, auth_failures: 0, ...opts.connection },
      ],
    },
    {
      rpc: (fn, args, tables) => {
        const a = args as Record<string, unknown>;
        if (fn === "pms_secret_get") return vault.secret;
        if (fn === "pms_secret_set") {
          vault.secret = a.p_secret as Record<string, unknown>;
          return "vault-id";
        }
        if (fn === "pms_note_auth_failure") {
          // 99_supabase_migration_connection_outage_notice_v1.sql: counts one
          // refusal, and the trigger puts the count back to 0 when a good
          // read moves last_sync_at.
          const conn = tables.pms_connections[0];
          if (!["connected", "degraded", "error"].includes(String(conn.status))) return [];
          if (conn.last_sync_at !== countedAtSync) conn.auth_failures = 0;
          countedAtSync = conn.last_sync_at;
          conn.auth_failures = Number(conn.auth_failures) + 1;
          if (Number(conn.auth_failures) >= Number(a.p_threshold) && conn.status !== "error") conn.status = "error";
          return [{ failures: conn.auth_failures, new_status: conn.status }];
        }
        return null;
      },
    },
  );

  const calls: Call[] = [];
  const tokenPosts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: { headers?: Record<string, string>; body?: string }) => {
      const url = new URL(String(input));
      if (String(input).startsWith(TOKEN_URL)) {
        tokenPosts.push(new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "");
        return (opts.tokens ?? mints)(tokenPosts.length);
      }
      expect(String(input).startsWith(API)).toBe(true);
      const call: Call = {
        method: url.pathname.split("/").pop() ?? "",
        token: String(init?.headers?.Authorization ?? "").replace(/^Bearer /, ""),
        page: Number(url.searchParams.get("pageNumber") ?? "1"),
      };
      calls.push(call);
      return opts.api(call, calls) ?? goodAnswer(call.method, opts.book ?? BOOK, call.page);
    }),
  );

  return { db, vault, calls, tokenPosts, connection: () => db.tables.pms_connections[0] };
}

const mints = (n: number) =>
  json(200, { access_token: `cbat_${n + 1}`, refresh_token: `refresh_${n + 1}`, expires_in: 3600, token_type: "Bearer" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.CLOUDBEDS_CLIENT_ID = "cid";
  process.env.CLOUDBEDS_CLIENT_SECRET = "csecret";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.CLOUDBEDS_CLIENT_ID;
  delete process.env.CLOUDBEDS_CLIENT_SECRET;
});

describe("a read Cloudbeds refuses once", () => {
  it("is asked again on a new token, and the run carries on as if nothing happened", async () => {
    const w = world({ api: (call) => (call.token === "cbat_1" ? refusedToken() : null) });

    const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(w.connection().status).toBe("connected");
    expect(w.connection().last_sync_at).toEqual(expect.any(String));
    // Refused, a new token, the same read again, and every read after it on the new token.
    expect(w.calls.slice(0, 2)).toEqual([
      { method: "getRoomTypes", token: "cbat_1", page: 1 },
      { method: "getRoomTypes", token: "cbat_2", page: 1 },
    ]);
    expect(w.calls.slice(2).every((c) => c.token === "cbat_2")).toBe(true);
    expect(w.calls.map((c) => c.method)).toContain("getReservationsWithRateDetails");
    expect(w.tokenPosts).toEqual(["refresh_1"]);
    // The new pair is what the next run starts from.
    expect(w.vault.secret).toMatchObject({ accessToken: "cbat_2", refreshToken: "refresh_2" });
    expect(w.db.tables.reservations.map((r) => [r.external_reservation_id, r.stay_date, r.current_rate])).toEqual([
      ["5538214799001-1", "2026-08-15", 240],
      ["5538214799001-1", "2026-08-16", 240],
    ]);
    if (res.ok) {
      expect(res.ingest.tokenRefreshed).toBe(true);
      // The credentials the rate push is handed carry the token that works.
      expect(res.creds.accessToken).toBe("cbat_2");
    }
  });

  it("is asked again the same way when the refusal is a 403", async () => {
    const w = world({ api: (call) => (call.token === "cbat_1" ? refusedToken(403) : null) });

    const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(w.connection().status).toBe("connected");
    expect(w.tokenPosts).toHaveLength(1);
  });

  it("is asked again when the token stops working part way through the bookings", async () => {
    const book = Array.from({ length: 150 }, (_, i) =>
      booking({ id: String(5538214800000 + i), status: "confirmed", checkIn: "2026-09-01", checkOut: "2026-09-02" }),
    );
    const w = world({
      book,
      api: (call) => (call.token === "cbat_1" && call.method === "getReservationsWithRateDetails" && call.page === 2 ? refusedToken() : null),
    });

    const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(w.connection().status).toBe("connected");
    expect(w.calls.filter((c) => c.method === "getReservationsWithRateDetails").map((c) => [c.page, c.token])).toEqual([
      [1, "cbat_1"],
      [2, "cbat_1"],
      [2, "cbat_2"],
    ]);
    expect(w.db.tables.reservations).toHaveLength(150);
  });

  it("takes the token another run has stored since, without spending the refresh token", async () => {
    const w = world({
      api: (call, calls) => {
        if (call.token !== "cbat_1") return null;
        // The import worker refreshed while this run was reading.
        if (calls.length === 1) {
          w.vault.secret = { ...w.vault.secret, accessToken: "cbat_elsewhere", refreshToken: "refresh_elsewhere" };
        }
        return refusedToken();
      },
    });

    const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(w.tokenPosts).toEqual([]);
    expect(w.calls[1]).toMatchObject({ method: "getRoomTypes", token: "cbat_elsewhere" });
    expect(w.vault.secret).toMatchObject({ refreshToken: "refresh_elsewhere" });
  });
});

describe("a read Cloudbeds refuses twice", () => {
  it("disconnects the hotel once the new token is refused too", async () => {
    const w = world({ api: () => refusedToken() });

    const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(res).toMatchObject({ ok: false, cloudbedsStatus: 401 });
    expect(w.connection().status).toBe("disconnected");
    // One new token, one more try, and no third.
    expect(w.calls).toEqual([
      { method: "getRoomTypes", token: "cbat_1", page: 1 },
      { method: "getRoomTypes", token: "cbat_2", page: 1 },
    ]);
    expect(w.tokenPosts).toHaveLength(1);
  });

  it("disconnects when a later read of the run is refused on the new token", async () => {
    const w = world({
      api: (call) => {
        if (call.token === "cbat_1") return refusedToken();
        return call.method === "getReservationsWithRateDetails" ? refusedToken(403) : null;
      },
    });

    const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(res).toMatchObject({ ok: false, cloudbedsStatus: 403 });
    expect(w.connection().status).toBe("disconnected");
    expect(w.tokenPosts).toHaveLength(1);
  });
});

describe("Cloudbeds saying the app is not connected", () => {
  it("disconnects at once: no token changes that", async () => {
    const w = world({ api: () => NOT_CONNECTED.clone() });

    const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(res.ok).toBe(false);
    expect(w.connection().status).toBe("disconnected");
    expect(w.calls).toHaveLength(1);
    expect(w.tokenPosts).toEqual([]);
  });

  it("disconnects when the same words come with a 401", async () => {
    const w = world({ api: () => json(401, { success: false, message: "App is not connected to this property." }) });

    await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(w.connection().status).toBe("disconnected");
    expect(w.tokenPosts).toEqual([]);
  });
});

describe("an error page that is not Cloudbeds' own", () => {
  it.each([
    ["a firewall's 403 page", () => blockPage(403)],
    ["a gateway's 401 page", () => blockPage(401)],
    ["a 403 with nothing in it", () => new Response("", { status: 403 })],
    ["a 403 in JSON that is not Cloudbeds' envelope", () => json(403, { code: 1020, detail: "blocked" })],
  ])("is an outage: %s", async (_name, page) => {
    const w = world({ api: () => page() });

    const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(res.ok).toBe(false);
    expect(w.connection().status).toBe("connected");
    // No token is spent on it and it is not counted towards anything.
    expect(w.tokenPosts).toEqual([]);
    expect(w.connection().auth_failures).toBe(0);
    expect(w.calls).toHaveLength(1);
  });

  it("stays an outage however many runs it lasts", async () => {
    const w = world({ api: () => blockPage() });

    for (let run = 0; run < 6; run++) await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(w.connection().status).toBe("connected");
    expect(w.connection().auth_failures).toBe(0);
  });

  it("leaves a 500, a 429 and a timeout alone, as before", async () => {
    for (const answer of [() => json(500, { success: false, message: "Internal error" }), () => json(503, {})]) {
      const w = world({ api: () => answer() });
      const res = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");
      expect(res.ok).toBe(false);
      expect(w.connection().status).toBe("connected");
      expect(w.tokenPosts).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});

describe("a refusal with no new token to be had", () => {
  const tokenHostDown = () => json(503, { error: "temporarily_unavailable" });

  it("fails the run and leaves the hotel connected the first and the second time", async () => {
    const w = world({ api: () => refusedToken(), tokens: tokenHostDown });

    const first = await runCloudbedsSyncForHotel(w.db.client, "hotel-1");
    expect(first).toMatchObject({ ok: false, cloudbedsStatus: 401 });
    expect(w.connection().status).toBe("connected");

    await runCloudbedsSyncForHotel(w.db.client, "hotel-1");
    expect(w.connection().status).toBe("connected");
    expect(w.connection().auth_failures).toBe(2);
  });

  it("disconnects the hotel on the third run in a row", async () => {
    expect(REFUSED_RUNS_BEFORE_DISCONNECT).toBe(3);
    const w = world({ api: () => refusedToken(), tokens: tokenHostDown });

    for (let run = 0; run < 3; run++) await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(w.connection().status).toBe("disconnected");
  });

  it("starts counting again after a run that read", async () => {
    let refusing = true;
    const w = world({ api: () => (refusing ? refusedToken() : null), tokens: tokenHostDown });

    await runCloudbedsSyncForHotel(w.db.client, "hotel-1");
    await runCloudbedsSyncForHotel(w.db.client, "hotel-1");
    refusing = false;
    expect((await runCloudbedsSyncForHotel(w.db.client, "hotel-1")).ok).toBe(true);
    refusing = true;
    vi.setSystemTime(new Date(NOW.getTime() + 600_000));
    await runCloudbedsSyncForHotel(w.db.client, "hotel-1");
    await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(w.connection().status).toBe("connected");
    expect(w.connection().auth_failures).toBe(2);
  });

  it("counts a token endpoint that hands the refused token back as no new token", async () => {
    const w = world({
      api: () => refusedToken(),
      tokens: () => json(200, { access_token: "cbat_1", refresh_token: "refresh_1", expires_in: 3600, token_type: "Bearer" }),
    });

    await runCloudbedsSyncForHotel(w.db.client, "hotel-1");

    expect(w.connection().status).toBe("connected");
    expect(w.calls).toHaveLength(1);
    expect(w.connection().auth_failures).toBe(1);
  });
});
