/**
 * Cloudbeds require an app that cannot be disconnected from its own UI to
 * subscribe to `integration/appstate_changed`. These pin the two things that
 * make that subscription safe: it never duplicates, and it never takes a
 * working connect down with it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appStateWebhookUrl, ensureAppStateWebhook } from "./cloudbeds-webhooks";
import type { CloudbedsResolvedCredentials } from "../../../supabase/functions/_shared/cloudbeds/types";

const CREDS: CloudbedsResolvedCredentials = {
  accessToken: "tok",
  tokenType: "Bearer",
  baseUrl: "https://hotels.cloudbeds.com/api/v1.2",
  propertyId: "320691",
};
const HOTEL = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";

afterEach(() => {
  delete process.env.MAYA_INVITE_REDIRECT_BASE;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cloudbeds(handlers: { get?: unknown[]; postOk?: boolean }) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), body: init?.body });
    if (String(url).includes("getWebhooks")) {
      return new Response(JSON.stringify({ success: true, data: handlers.get ?? [] }), { status: 200 });
    }
    if (handlers.postOk === false) {
      return new Response(JSON.stringify({ success: false, message: "nope" }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, data: { subscriptionID: "sub_1" } }), { status: 200 });
  });
  return calls;
}

describe("appStateWebhookUrl", () => {
  it("builds a per-hotel URL, so the subscription itself carries the identity", () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com/";
    expect(appStateWebhookUrl(HOTEL)).toBe(`https://maya-rms.com/api/pms/cloudbeds/webhook/${HOTEL}`);
  });

  it("refuses localhost rather than registering an unreachable endpoint", () => {
    // Cloudbeds would accept it and then burn five retries a minute apart
    // failing to reach someone's laptop.
    process.env.MAYA_INVITE_REDIRECT_BASE = "http://localhost:3000";
    expect(appStateWebhookUrl(HOTEL)).toBeNull();
  });

  it("returns null when no base URL is configured at all", () => {
    expect(appStateWebhookUrl(HOTEL)).toBeNull();
  });
});

describe("ensureAppStateWebhook", () => {
  it("subscribes when nothing is subscribed yet", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com";
    const calls = cloudbeds({ get: [] });

    expect(await ensureAppStateWebhook(CREDS, HOTEL)).toEqual({ ok: true, state: "created" });

    // Form-encoded, not JSON: postWebhook rejects a JSON body with
    // "Parameter endpointUrl is required" (found against the live sandbox).
    const post = calls.find((c) => c.url.includes("postWebhook"))!;
    const body = new URLSearchParams(post.body!);
    expect(body.get("object")).toBe("integration");
    expect(body.get("action")).toBe("appstate_changed");
    expect(body.get("endpointUrl")).toBe(`https://maya-rms.com/api/pms/cloudbeds/webhook/${HOTEL}`);
    expect(body.get("propertyID")).toBe("320691");
  });

  it("does not subscribe twice — duplicates mean every event arrives twice", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com";
    const calls = cloudbeds({
      get: [
        {
          id: "sub_existing",
          event: { entity: "integration", action: "appstate_changed" },
          subscriptionData: { url: `https://maya-rms.com/api/pms/cloudbeds/webhook/${HOTEL}` },
        },
      ],
    });

    expect(await ensureAppStateWebhook(CREDS, HOTEL)).toEqual({
      ok: true,
      state: "already_subscribed",
    });
    expect(calls.some((c) => c.url.includes("postWebhook"))).toBe(false);
  });

  it("still subscribes when the existing subscription points at a different hotel", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com";
    const calls = cloudbeds({
      get: [
        {
          id: "sub_other",
          event: { entity: "integration", action: "appstate_changed" },
          subscriptionData: { url: "https://maya-rms.com/api/pms/cloudbeds/webhook/some-other-hotel" },
        },
      ],
    });

    expect(await ensureAppStateWebhook(CREDS, HOTEL)).toEqual({ ok: true, state: "created" });
    expect(calls.some((c) => c.url.includes("postWebhook"))).toBe(true);
  });

  it("omits propertyID when it is not known yet, as Flow B does at connect time", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com";
    const calls = cloudbeds({ get: [] });

    await ensureAppStateWebhook({ ...CREDS, propertyId: "" }, HOTEL);

    const body = new URLSearchParams(calls.find((c) => c.url.includes("postWebhook"))!.body!);
    expect(body.has("propertyID")).toBe(false);
  });

  it("reports a vendor refusal instead of throwing — a connect must not fail over this", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com";
    cloudbeds({ get: [], postOk: false });

    const res = await ensureAppStateWebhook(CREDS, HOTEL);
    expect(res.ok).toBe(false);
  });

  it("reports a network failure instead of throwing", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com";
    vi.stubGlobal("fetch", async () => {
      throw new Error("socket hang up");
    });

    const res = await ensureAppStateWebhook(CREDS, HOTEL);
    expect(res).toEqual({ ok: false, reason: expect.stringContaining("socket hang up") });
  });

  it("declines without calling Cloudbeds at all when there is no public URL", async () => {
    const calls = cloudbeds({ get: [] });
    expect(await ensureAppStateWebhook(CREDS, HOTEL)).toEqual({
      ok: false,
      reason: "no_public_base_url",
    });
    expect(calls).toHaveLength(0);
  });
});
