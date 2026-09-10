/**
 * The receiving half of the Cloudbeds disconnect requirement.
 *
 * Two rules govern this route and both are load-bearing: it must answer 2xx to
 * everything (Cloudbeds retry five times a minute apart on anything else, and a
 * retry cannot fix a payload we do not understand), and it must only act on
 * `disabled` — acting on `enabled` or `pending` would disconnect a property in
 * the middle of connecting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const marked: { hotelId: string; reason: string }[] = [];

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({}) as never,
}));
vi.mock("@/lib/pms/connection-health", () => ({
  markConnectionDisconnected: async (
    _s: unknown,
    hotelId: string,
    _p: string,
    reason: string,
  ) => {
    marked.push({ hotelId, reason });
  },
}));

const { POST } = await import("@/app/api/pms/cloudbeds/webhook/[hotelId]/[token]/route");

const HOTEL = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";

// A real signature, computed the same way the subscription URL is built.
process.env.PMS_OAUTH_STATE_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const { createHmac } = await import("node:crypto");
const TOKEN = createHmac("sha256", Buffer.from(process.env.PMS_OAUTH_STATE_SECRET, "hex"))
  .update(`cloudbeds-webhook:${HOTEL}`)
  .digest("hex")
  .slice(0, 32);

const params = Promise.resolve({ hotelId: HOTEL, token: TOKEN });

function post(body: string, contentType = "application/json") {
  return new Request("https://maya-rms.com/api/pms/cloudbeds/webhook/x", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

afterEach(() => {
  marked.length = 0;
});

describe("cloudbeds appstate webhook", () => {
  it("disconnects the property when the app is disabled", async () => {
    const res = await POST(
      post(JSON.stringify({ event: "integration/appstate_changed", state: "disabled", propertyID_str: "320691" })),
      { params },
    );
    expect(res.status).toBe(200);
    expect(marked).toHaveLength(1);
    expect(marked[0].hotelId).toBe(HOTEL);
  });

  it("accepts a form-encoded delivery, since their docs show both", async () => {
    const res = await POST(
      post("event=integration%2Fappstate_changed&state=disabled&propertyID=320691", "application/x-www-form-urlencoded"),
      { params },
    );
    expect(res.status).toBe(200);
    expect(marked).toHaveLength(1);
  });

  it("reads the state from app_state as well as state", async () => {
    await POST(
      post(JSON.stringify({ event: "integration/appstate_changed", app_state: "DISABLED" })),
      { params },
    );
    expect(marked).toHaveLength(1);
  });

  it("does NOT disconnect on enabled — that arrives mid-connect", async () => {
    const res = await POST(
      post(JSON.stringify({ event: "integration/appstate_changed", state: "enabled" })),
      { params },
    );
    expect(res.status).toBe(200);
    expect(marked).toHaveLength(0);
  });

  it("does NOT disconnect on pending or installing", async () => {
    for (const state of ["pending", "installing"]) {
      await POST(post(JSON.stringify({ event: "integration/appstate_changed", state })), { params });
    }
    expect(marked).toHaveLength(0);
  });

  it("ignores an unrelated event that lands on this endpoint", async () => {
    const res = await POST(
      post(JSON.stringify({ event: "reservation/created", state: "disabled" })),
      { params },
    );
    expect(res.status).toBe(200);
    expect(marked).toHaveLength(0);
  });

  it("answers 200 to an unparseable body rather than inviting five retries", async () => {
    const res = await POST(post("<<not json or form>>"), { params });
    expect(res.status).toBe(200);
    expect(marked).toHaveLength(0);
  });

  it("answers 200 to an empty body", async () => {
    const res = await POST(post(""), { params });
    expect(res.status).toBe(200);
    expect(marked).toHaveLength(0);
  });

  it("REFUSES an unsigned request — this route is a kill switch without that", async () => {
    // Disconnecting removes the hotel from claim_pms_sync_batch, which selects
    // `where status <> 'disconnected'`. Nothing puts it back. An unauthenticated
    // POST would stop a live property's pricing indefinitely.
    const res = await POST(
      post(JSON.stringify({ event: "integration/appstate_changed", state: "disabled" })),
      { params: Promise.resolve({ hotelId: HOTEL, token: "not-the-right-token-at-all" }) },
    );
    expect(res.status).toBe(200); // same answer as a good one — not an oracle
    expect(marked).toHaveLength(0);
  });

  it("refuses a token of the right length but the wrong value", async () => {
    const wrong = "0".repeat(TOKEN.length);
    await POST(
      post(JSON.stringify({ event: "integration/appstate_changed", state: "disabled" })),
      { params: Promise.resolve({ hotelId: HOTEL, token: wrong }) },
    );
    expect(marked).toHaveLength(0);
  });

  it("refuses another hotel's token", async () => {
    const otherHotel = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
    await POST(
      post(JSON.stringify({ event: "integration/appstate_changed", state: "disabled" })),
      { params: Promise.resolve({ hotelId: otherHotel, token: TOKEN }) },
    );
    expect(marked).toHaveLength(0);
  });

  it("carries a reason a human can read in the alert", async () => {
    await POST(
      post(JSON.stringify({ event: "integration/appstate_changed", state: "disabled" })),
      { params },
    );
    expect(marked[0].reason).toContain("uninstalled");
  });
});
