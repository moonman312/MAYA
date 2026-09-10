/**
 * Alerting is the difference between "we recorded it" and "someone found out".
 * It is also the thing most likely to make a bad situation worse, so the rules
 * are: never throw, never block the caller, and never spam the same condition.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { raiseAlert } from "../../../supabase/functions/_shared/pms/alerting";
import type { SupabaseClient } from "@supabase/supabase-js";

function stub(recentAlerts: unknown[] = []) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    from() {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte"]) q[m] = () => q;
      q.limit = async () => ({ data: recentAlerts });
      return q;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { supabase, rpcs };
}

const ALERT = {
  severity: "critical" as const,
  key: "pms_disconnected:cloudbeds:h1",
  title: "cloudbeds connection revoked",
  detail: "401 from getReservations",
  hotelId: "h1",
};

afterEach(() => {
  delete process.env.MAYA_ALERT_WEBHOOK;
  delete process.env.MAYA_ALERT_MIN_SEVERITY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("raiseAlert", () => {
  it("is inert until a webhook is configured, so it ships safely unset", async () => {
    const { supabase } = stub();
    expect(await raiseAlert(supabase, ALERT)).toEqual({ sent: false, reason: "no_webhook_configured" });
  });

  it("posts a Slack-shaped payload and records the send", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    });
    const { supabase, rpcs } = stub();

    expect(await raiseAlert(supabase, ALERT)).toEqual({ sent: true });
    const payload = JSON.parse(calls[0].body);
    expect(payload.text).toContain("cloudbeds connection revoked");
    expect(payload.severity).toBe("critical");
    expect(rpcs.find((r) => r.name === "platform_log_event")?.args.p_event_type).toBe("alert.raised");
  });

  it("stays silent on a warning, because warnings are what stop people looking", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response("ok", { status: 200 });
    });
    const { supabase } = stub();

    expect(await raiseAlert(supabase, { ...ALERT, severity: "warn" })).toEqual({
      sent: false,
      reason: "below_min_severity",
    });
    expect(calls).toHaveLength(0);
  });

  it("sends warnings too once MAYA_ALERT_MIN_SEVERITY says warn", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    process.env.MAYA_ALERT_MIN_SEVERITY = "warn";
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));
    const { supabase } = stub();

    expect(await raiseAlert(supabase, { ...ALERT, severity: "warn" })).toEqual({ sent: true });
  });

  it("still sends criticals when the floor is widened", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    process.env.MAYA_ALERT_MIN_SEVERITY = "warn";
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));
    const { supabase } = stub();

    expect(await raiseAlert(supabase, ALERT)).toEqual({ sent: true });
  });

  it("does not re-send a condition already alerted in the window", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { supabase } = stub([{ id: "prior" }]);

    expect(await raiseAlert(supabase, ALERT)).toEqual({ sent: false, reason: "deduped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows a webhook failure rather than breaking the caller", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase } = stub();
    expect(await raiseAlert(supabase, ALERT)).toEqual({ sent: false, reason: "send_failed" });
  });

  it("ignores a non-https webhook rather than leaking alerts in cleartext", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "http://insecure.example.com/abc";
    const { supabase } = stub();
    expect(await raiseAlert(supabase, ALERT)).toMatchObject({ sent: false, reason: "no_webhook_configured" });
  });
});
