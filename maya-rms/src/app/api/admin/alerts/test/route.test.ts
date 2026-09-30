/**
 * "Send a test alert" on the Command Center asks a scheduled sync function
 * to post one message to the alert channel, over the function's cron
 * endpoint with the cron secret, so the test uses the settings real alerts
 * use. Only a platform admin gets through, the button says plainly what is
 * missing and where, and no secret or address ever leaves the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const FUNCTION_URL = "https://proj.supabase.co/functions/v1/cloudbeds-scheduled-sync";

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
/** What the function answers. */
let answer: () => Promise<Response> = async () =>
  new Response(JSON.stringify({ ok: true, test: { sent: true, state: "ready", minSeverity: "warn" } }), { status: 200 });

beforeEach(() => {
  state.isAdmin = true;
  state.throttled = false;
  state.events = [];
  calls = [];
  answer = async () =>
    new Response(JSON.stringify({ ok: true, test: { sent: true, state: "ready", minSeverity: "warn" } }), { status: 200 });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
  process.env.CLOUDBEDS_CRON_SECRET = "CRONSECRET";
  // The app's own copy of the address: set, and beside the point.
  process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/services/T0/B0/HOOKSECRET";
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
  delete process.env.CLOUDBEDS_CRON_SECRET;
  delete process.env.THINK_CRON_SECRET;
  delete process.env.MEWS_CRON_SECRET;
  vi.unstubAllGlobals();
});

async function send() {
  const res = await POST();
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { ok?: boolean; error?: string; fn?: string; minSeverity?: string } };
}

describe("POST /api/admin/alerts/test", () => {
  it("refuses anyone who is not a platform admin, and asks nothing", async () => {
    state.isAdmin = false;
    const res = await send();
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("says plainly when the app holds no cron secret to ask a function with, and asks nothing", async () => {
    delete process.env.CLOUDBEDS_CRON_SECRET;
    const res = await send();
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("set CLOUDBEDS_CRON_SECRET");
    expect(calls).toHaveLength(0);
  });

  it("asks the function once, over its cron endpoint with the secret, and hands back its answer", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, fn: "cloudbeds-scheduled-sync", minSeverity: "warn" });
    expect(res.text).not.toContain("HOOKSECRET");
    expect(res.text).not.toContain("CRONSECRET");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(FUNCTION_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(calls[0].init.headers).get("x-cloudbeds-cron-secret")).toBe("CRONSECRET");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: "test_alert", sent_by: "ops@mhs.test" });
    // The app never posts to the webhook itself.
    expect(calls.some((c) => c.url.includes("hooks.example.com"))).toBe(false);
    expect(state.events).toEqual([
      expect.objectContaining({ p_event_type: "alert.test_sent", p_detail: { via: "cloudbeds-scheduled-sync", sent: true } }),
    ]);
  });

  it("says where the address is missing when the function has none, whatever the app has", async () => {
    answer = async () =>
      new Response(JSON.stringify({ ok: true, test: { sent: false, reason: "no_webhook_configured", state: "missing", minSeverity: "critical" } }), {
        status: 200,
      });
    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("MAYA_ALERT_WEBHOOK isn't set in the Supabase function secrets");
    expect(res.body.error).toContain("Real alerts are being skipped");
    expect(res.body.fn).toBe("cloudbeds-scheduled-sync");
    expect(state.events).toEqual([expect.objectContaining({ p_detail: { via: "cloudbeds-scheduled-sync", sent: false } })]);
  });

  it("says when the channel refused the function's message, without the address", async () => {
    answer = async () =>
      new Response(JSON.stringify({ ok: true, test: { sent: false, reason: "webhook_404", state: "ready", minSeverity: "critical" } }), {
        status: 200,
      });
    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("refused the message from cloudbeds-scheduled-sync (HTTP 404)");
    expect(res.text).not.toContain("HOOKSECRET");
  });

  it("says when the function refused the app's secret, and when it did not answer", async () => {
    answer = async () => new Response(JSON.stringify({ ok: false, error: "Invalid or missing x-cloudbeds-cron-secret." }), { status: 401 });
    expect((await send()).body.error).toContain("refused the app's secret");

    answer = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("cloudbeds-scheduled-sync didn't answer within 20 seconds");
  });

  it("is throttled, and a throttled press asks nothing", async () => {
    state.throttled = true;
    expect((await send()).status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("answers POST only", () => {
    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });
});
