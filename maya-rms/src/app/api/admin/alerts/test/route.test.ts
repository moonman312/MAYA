/**
 * "Send a test alert" on the Command Center posts one message to the alert
 * channel. Only a platform admin gets through, the button says plainly when
 * MAYA_ALERT_WEBHOOK is missing, and the webhook address never leaves the
 * server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const HOOK = "https://hooks.example.com/services/T0/B0/HOOKSECRET";

const state = vi.hoisted(() => ({
  isAdmin: true,
  throttled: false,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/admin/require-platform-admin", () => ({
  requirePlatformAdmin: async () => {
    const ssr = {
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        state.events.push(args);
        return { data: null, error: null };
      },
    };
    return state.isAdmin
      ? { ok: true, user: { id: "admin-1", email: "ops@mhs.test" }, ssr, admin: ssr }
      : { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: async () =>
    state.throttled ? NextResponse.json({ error: "A few test alerts were just sent." }, { status: 429 }) : null,
}));

const route = await import("./route");
const { POST } = route;

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let answer: () => Promise<Response> = async () => new Response("ok", { status: 200 });

beforeEach(() => {
  state.isAdmin = true;
  state.throttled = false;
  state.events = [];
  calls = [];
  answer = async () => new Response("ok", { status: 200 });
  process.env.MAYA_ALERT_WEBHOOK = HOOK;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer();
    }),
  );
});

afterEach(() => {
  delete process.env.MAYA_ALERT_WEBHOOK;
  vi.unstubAllGlobals();
});

async function send() {
  const res = await POST();
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { ok?: boolean; error?: string } };
}

describe("POST /api/admin/alerts/test", () => {
  it("refuses anyone who is not a platform admin, and sends nothing", async () => {
    state.isAdmin = false;
    const res = await send();
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("says plainly when MAYA_ALERT_WEBHOOK is missing, and sends nothing", async () => {
    delete process.env.MAYA_ALERT_WEBHOOK;
    const res = await send();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(
      "MAYA_ALERT_WEBHOOK isn't set for this app, so there's nowhere to send alerts. Add it to the app's environment variables in Vercel, then redeploy.",
    );
    expect(calls).toHaveLength(0);
  });

  it("will not send to an address that is not https", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "http://hooks.example.com/plain";
    const res = await send();
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("isn't an https:// address");
    expect(res.text).not.toContain("hooks.example.com");
    expect(calls).toHaveLength(0);
  });

  it("posts exactly one message, with a timeout, and never hands back the address", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.text).not.toContain("HOOKSECRET");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(HOOK);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(String(calls[0].init.body)) as { text: string };
    expect(payload.text).toContain("Test alert from the MAYA Command Center, sent by ops@mhs.test");
    expect(state.events).toEqual([expect.objectContaining({ p_event_type: "alert.test_sent" })]);
  });

  it("says when the channel refuses the message, without the address", async () => {
    answer = async () => new Response("no_service", { status: 404 });
    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("refused the message (HTTP 404)");
    expect(res.text).not.toContain("HOOKSECRET");
    expect(state.events).toHaveLength(0);
  });

  it("says when the channel does not answer in time", async () => {
    answer = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("The alert channel didn't answer within 5 seconds, so the test may not have arrived.");
  });

  it("is throttled, and a throttled press sends nothing", async () => {
    state.throttled = true;
    expect((await send()).status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("answers POST only", () => {
    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });
});
