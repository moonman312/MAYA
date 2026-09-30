/**
 * A passing test alert has to prove that REAL alerts arrive. Real alerts are
 * raised inside the scheduled sync functions, with the function secrets; the
 * Command Center button used to post with the app's own copy of the address,
 * so it passed with the function's copy missing and every real alert skipped.
 *
 * Here the button's request is answered by the function-side handler, over a
 * stubbed fetch that plays the function's endpoint, with the function's
 * environment separate from the app's; the function's report and the test's
 * outcome land in platform_audit_events; and the Pilot health line reads them
 * back. Plus the one log line an alert with nowhere to go now leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_CHANNEL_EVENT,
  ALERT_CHANNEL_REPORT_EVERY_MS,
  ALERT_CHANNEL_TEST_EVENT,
  alertChannelReport,
  raiseAlert,
  recordAlertChannel,
  sendAlertChannelTest,
} from "../../../supabase/functions/_shared/pms/alerting";
import {
  handleTestAlertRequest,
  parseScheduledSyncBody,
  TEST_ALERT_ACTION,
} from "../../../supabase/functions/_shared/pms/alert-test-request";
import { alertChannelFacts, describeAlertChannel } from "@/lib/admin/alert-channel";
import { fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

/**
 * A database whose platform_log_event writes rows the page reads back, the
 * way the real function does (platform_audit_events, service role).
 */
function db(seed: FakeRow[] = []) {
  const made = fakeSupabase(
    { platform_audit_events: seed },
    {
      rpc: (fn, args, tables) => {
        if (fn !== "platform_log_event") return null;
        const a = args as Record<string, unknown>;
        // Strictly later than the row before, as Postgres's clock is.
        const n = tables.platform_audit_events.length;
        const lastMs = n > 0 ? Date.parse(String(tables.platform_audit_events[n - 1].created_at)) : 0;
        tables.platform_audit_events.push({
          id: `ev-${n + 1}`,
          event_type: a.p_event_type,
          entity_type: a.p_entity_type,
          entity_id: a.p_entity_id,
          hotel_id: a.p_hotel_id ?? null,
          detail: a.p_detail ?? {},
          created_at: new Date(Math.max(Date.now(), lastMs + 1)).toISOString(),
        });
        return "ev";
      },
    },
  );
  return made;
}

const events = (made: ReturnType<typeof db>) =>
  made.tables.platform_audit_events.map((r) => ({ type: r.event_type, fn: r.entity_id, detail: r.detail }));

/** The rows as the page reads them: newest first. */
const newestFirst = (made: ReturnType<typeof db>) =>
  [...made.tables.platform_audit_events].reverse().map((r) => ({
    event_type: r.event_type,
    entity_id: r.entity_id,
    detail: r.detail,
    created_at: r.created_at,
  }));

const NOW = new Date().toISOString();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.MAYA_ALERT_WEBHOOK;
  delete process.env.MAYA_ALERT_MIN_SEVERITY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an alert with nowhere to go", () => {
  it("leaves one log line naming the alert, instead of nothing", async () => {
    const made = db();
    const res = await raiseAlert(made.client, { severity: "critical", key: "pms_disconnected:cloudbeds:h1", title: "Cloudbeds access revoked", hotelId: "h1" });
    expect(res).toEqual({ sent: false, reason: "no_webhook_configured" });
    const lines = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line).toMatchObject({ fn: "raiseAlert", key: "pms_disconnected:cloudbeds:h1", severity: "critical", hotelId: "h1", reason: "no_webhook_configured", state: "missing" });
    expect(line.message).toContain("MAYA_ALERT_WEBHOOK");
    // Nothing is recorded as raised, so the next tick says it again.
    expect(events(made)).toEqual([]);
  });

  it("says not_https when the address is set but not https", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "http://hooks.example.com/abc";
    await raiseAlert(db().client, { severity: "critical", key: "k", title: "t" });
    expect(JSON.parse(String((console.error as ReturnType<typeof vi.fn>).mock.calls[0][0]))).toMatchObject({ state: "not_https" });
  });
});

describe("recordAlertChannel", () => {
  it("writes the function's report once, then again only when the state changes or six hours pass", async () => {
    const made = db();
    expect(await recordAlertChannel(made.client, "cloudbeds-scheduled-sync")).toEqual({
      recorded: true,
      report: { state: "missing", minSeverity: "critical" },
    });
    expect(await recordAlertChannel(made.client, "cloudbeds-scheduled-sync")).toMatchObject({ recorded: false });
    expect(events(made)).toEqual([
      { type: ALERT_CHANNEL_EVENT, fn: "cloudbeds-scheduled-sync", detail: { state: "missing", min_severity: "critical", fn: "cloudbeds-scheduled-sync" } },
    ]);

    // The address arrives in the function secrets: said at once.
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    expect(await recordAlertChannel(made.client, "cloudbeds-scheduled-sync")).toMatchObject({ recorded: true, report: { state: "ready" } });
    // The floor widens: a change too.
    process.env.MAYA_ALERT_MIN_SEVERITY = "warn";
    expect(await recordAlertChannel(made.client, "cloudbeds-scheduled-sync")).toMatchObject({ recorded: true, report: { minSeverity: "warn" } });
    expect(await recordAlertChannel(made.client, "cloudbeds-scheduled-sync")).toMatchObject({ recorded: false });
    // Six hours on with nothing changed: said again, so a current report can be told from a stale one.
    expect(
      await recordAlertChannel(made.client, "cloudbeds-scheduled-sync", { nowMs: Date.now() + ALERT_CHANNEL_REPORT_EVERY_MS + 60_000 }),
    ).toMatchObject({ recorded: true });
    expect(events(made)).toHaveLength(4);
    // Another function reports on its own.
    expect(await recordAlertChannel(made.client, "think-scheduled-sync")).toMatchObject({ recorded: true });
    // A failed read never throws and never fails the tick.
    const broken = fakeSupabase({ platform_audit_events: [] }, { fault: (c) => (c.table === "platform_audit_events" ? { message: "timeout" } : null) });
    expect(await recordAlertChannel(broken.client, "cloudbeds-scheduled-sync")).toMatchObject({ recorded: false, report: { state: "ready" } });
  });
});

describe("the test alert, asked of a scheduled sync function", () => {
  /** The function's endpoint: its own environment, its own database. */
  function functionEndpoint(made: ReturnType<typeof db>, opts: { secret: string | undefined; webhook?: string; minSeverity?: string; webhookStatus?: number }) {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://hooks.example.com/")) {
        posts.push({ url: target, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(opts.webhookStatus === 200 || opts.webhookStatus == null ? "ok" : "no", { status: opts.webhookStatus ?? 200 });
      }
      // The function runs here, with the function's settings, not the app's.
      const appWebhook = process.env.MAYA_ALERT_WEBHOOK;
      const appMin = process.env.MAYA_ALERT_MIN_SEVERITY;
      if (opts.webhook) process.env.MAYA_ALERT_WEBHOOK = opts.webhook;
      else delete process.env.MAYA_ALERT_WEBHOOK;
      if (opts.minSeverity) process.env.MAYA_ALERT_MIN_SEVERITY = opts.minSeverity;
      else delete process.env.MAYA_ALERT_MIN_SEVERITY;
      try {
        const headers = new Headers(init?.headers);
        if (opts.secret && headers.get("x-cloudbeds-cron-secret") !== opts.secret) {
          return new Response(JSON.stringify({ ok: false, error: "Invalid or missing x-cloudbeds-cron-secret." }), { status: 401 });
        }
        const body = parseScheduledSyncBody(String(init?.body ?? ""));
        const answer = await handleTestAlertRequest(made.client, body, {
          fn: "cloudbeds-scheduled-sync",
          secretEnv: "CLOUDBEDS_CRON_SECRET",
          secretConfigured: Boolean(opts.secret),
        });
        return answer ?? new Response(JSON.stringify({ ok: true, hotels: 0 }), { status: 200 });
      } finally {
        if (appWebhook == null) delete process.env.MAYA_ALERT_WEBHOOK;
        else process.env.MAYA_ALERT_WEBHOOK = appWebhook;
        if (appMin == null) delete process.env.MAYA_ALERT_MIN_SEVERITY;
        else process.env.MAYA_ALERT_MIN_SEVERITY = appMin;
      }
    });
    // The function's own post to the webhook goes through the global fetch.
    vi.stubGlobal("fetch", fetchStub);
    return { fetchStub, posts };
  }

  const APP_ENV = {
    NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co/",
    CLOUDBEDS_CRON_SECRET: "s3cret",
    // The app's own copy of the address: set, and beside the point.
    MAYA_ALERT_WEBHOOK: "https://hooks.example.com/apps-copy",
  } as unknown as NodeJS.ProcessEnv;

  it("passes only when the FUNCTION has the address, and the message goes through the function's post", async () => {
    const { sendTestAlert, testAlertProblem } = await import("@/lib/admin/test-alert");
    const made = db();
    const { fetchStub, posts } = functionEndpoint(made, { secret: "s3cret", webhook: "https://hooks.example.com/functions-copy", minSeverity: "warn" });
    expect(testAlertProblem(APP_ENV)).toBeNull();

    const result = await sendTestAlert("jake@example.com", { fetch: fetchStub as unknown as typeof fetch, env: APP_ENV });

    expect(result).toEqual({ sent: true, fn: "cloudbeds-scheduled-sync", minSeverity: "warn" });
    // Asked over the cron endpoint with the cron secret, as the cron does.
    const ask = fetchStub.mock.calls[0];
    expect(String(ask[0])).toBe("https://proj.supabase.co/functions/v1/cloudbeds-scheduled-sync");
    expect(new Headers(ask[1]?.headers).get("x-cloudbeds-cron-secret")).toBe("s3cret");
    expect(JSON.parse(String(ask[1]?.body))).toEqual({ action: TEST_ALERT_ACTION, sent_by: "jake@example.com" });
    // Posted to the function's address, never the app's.
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://hooks.example.com/functions-copy");
    expect(posts[0].body.text).toContain("Test alert from the MAYA Command Center, sent through cloudbeds-scheduled-sync by jake@example.com");
    // The function said what it found, and the page reads it back as ready.
    expect(events(made)).toEqual([
      { type: ALERT_CHANNEL_EVENT, fn: "cloudbeds-scheduled-sync", detail: { state: "ready", min_severity: "warn", fn: "cloudbeds-scheduled-sync" } },
      {
        type: ALERT_CHANNEL_TEST_EVENT,
        fn: "cloudbeds-scheduled-sync",
        detail: { fn: "cloudbeds-scheduled-sync", sent: true, state: "ready", min_severity: "warn", sent_by: "jake@example.com" },
      },
    ]);
    const line = describeAlertChannel(alertChannelFacts(newestFirst(made)), NOW);
    expect(line.verdict).toBe("ready");
    expect(line.text).toContain("Alerts: ready. cloudbeds-scheduled-sync said under a minute ago");
    expect(line.test).toContain("Last test alert: sent under a minute ago through cloudbeds-scheduled-sync for jake@example.com.");
  });

  it("fails, and says where the address is missing, when only the app has it", async () => {
    const { sendTestAlert } = await import("@/lib/admin/test-alert");
    const made = db();
    const { fetchStub, posts } = functionEndpoint(made, { secret: "s3cret", webhook: undefined });

    const result = await sendTestAlert(null, { fetch: fetchStub as unknown as typeof fetch, env: APP_ENV });

    expect(result).toMatchObject({ sent: false, fn: "cloudbeds-scheduled-sync" });
    expect((result as { error: string }).error).toContain("MAYA_ALERT_WEBHOOK isn't set in the Supabase function secrets");
    expect((result as { error: string }).error).toContain("Real alerts are being skipped");
    expect(posts).toEqual([]);
    // The function's report says missing, and the page says so.
    const line = describeAlertChannel(alertChannelFacts(newestFirst(made)), NOW);
    expect(line.verdict).toBe("missing");
    expect(line.text).toContain("cloudbeds-scheduled-sync said under a minute ago that MAYA_ALERT_WEBHOOK is not set in the Supabase function secrets");
    expect(line.test).toContain("not sent");
  });

  it("says when the channel refused the message, and when the address is not https", async () => {
    const { sendTestAlert } = await import("@/lib/admin/test-alert");
    const refused = functionEndpoint(db(), { secret: "s3cret", webhook: "https://hooks.example.com/gone", webhookStatus: 404 });
    expect(await sendTestAlert(null, { fetch: refused.fetchStub as unknown as typeof fetch, env: APP_ENV })).toMatchObject({
      sent: false,
      error: expect.stringContaining("refused the message from cloudbeds-scheduled-sync (HTTP 404)"),
    });
    const insecure = functionEndpoint(db(), { secret: "s3cret", webhook: "http://hooks.example.com/abc" });
    expect(await sendTestAlert(null, { fetch: insecure.fetchStub as unknown as typeof fetch, env: APP_ENV })).toMatchObject({
      sent: false,
      error: expect.stringContaining("isn't an https:// address"),
    });
    expect(insecure.posts).toEqual([]);
  });

  it("is refused by the function when its secret is not configured, and when the app's differs", async () => {
    const { sendTestAlert } = await import("@/lib/admin/test-alert");
    const made = db();
    const unset = functionEndpoint(made, { secret: undefined, webhook: "https://hooks.example.com/x" });
    const result = await sendTestAlert(null, { fetch: unset.fetchStub as unknown as typeof fetch, env: APP_ENV });
    expect(result).toMatchObject({ sent: false, error: expect.stringContaining("CLOUDBEDS_CRON_SECRET is not set for cloudbeds-scheduled-sync") });
    expect(unset.posts).toEqual([]);
    expect(events(made)).toEqual([]);

    const other = functionEndpoint(made, { secret: "different", webhook: "https://hooks.example.com/x" });
    expect(await sendTestAlert(null, { fetch: other.fetchStub as unknown as typeof fetch, env: APP_ENV })).toMatchObject({
      sent: false,
      error: expect.stringContaining("refused the app's secret"),
    });
    expect(other.posts).toEqual([]);
  });

  it("says what the app is missing when it cannot ask any function", async () => {
    const { sendTestAlert, testAlertProblem, testAlertRoute } = await import("@/lib/admin/test-alert");
    const bare = { NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co", MAYA_ALERT_WEBHOOK: "https://hooks.example.com/apps-copy" } as unknown as NodeJS.ProcessEnv;
    expect(testAlertRoute(bare)).toBeNull();
    expect(testAlertProblem(bare)).toContain("CLOUDBEDS_CRON_SECRET");
    const fetchStub = vi.fn();
    expect(await sendTestAlert(null, { fetch: fetchStub as unknown as typeof fetch, env: bare })).toMatchObject({ sent: false, fn: null });
    expect(fetchStub).not.toHaveBeenCalled();
    // Think's secret alone will do: the function secrets are shared.
    expect(testAlertRoute({ ...bare, THINK_CRON_SECRET: "t" } as NodeJS.ProcessEnv)).toMatchObject({ fn: "think-scheduled-sync", header: "x-think-cron-secret" });
  });

  it("the function ignores a body that is not a test, and answers a test even when a hotel id rides along", async () => {
    const made = db();
    expect(parseScheduledSyncBody("")).toEqual({});
    expect(parseScheduledSyncBody("not json")).toEqual({});
    expect(parseScheduledSyncBody(JSON.stringify({ hotel_id: "h1" }))).toEqual({ hotel_id: "h1" });
    expect(parseScheduledSyncBody(JSON.stringify({ scheduled_at: "x" }))).toEqual({});
    expect(await handleTestAlertRequest(made.client, { hotel_id: "h1" }, { fn: "f", secretEnv: "S", secretConfigured: true })).toBeNull();
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const res = await handleTestAlertRequest(made.client, { action: "test_alert" }, { fn: "f", secretEnv: "S", secretConfigured: true });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, test: { sent: true, state: "ready", minSeverity: "critical" } });
  });

  it("sendAlertChannelTest never returns the address, and records a failed post as such", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/secret-path";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const made = db();
    const test = await sendAlertChannelTest(made.client, { fn: "f", sentBy: "a@b.c" });
    expect(test).toEqual({ sent: false, reason: "webhook_500", state: "ready", minSeverity: "critical" });
    expect(JSON.stringify(test)).not.toContain("secret-path");
    expect(JSON.stringify(events(made))).not.toContain("secret-path");
    expect(alertChannelReport()).toEqual({ state: "ready", minSeverity: "critical" });
  });
});

describe("the Pilot health line", () => {
  const report = (fn: string, state: string, minutesAgo: number, min = "critical") => ({
    event_type: ALERT_CHANNEL_EVENT,
    entity_id: fn,
    detail: { fn, state, min_severity: min },
    created_at: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString(),
  });

  it("takes the newest report per function and the newest test, whatever order the rows come in", () => {
    const facts = alertChannelFacts([
      report("cloudbeds-scheduled-sync", "ready", 5, "warn"),
      { event_type: ALERT_CHANNEL_TEST_EVENT, entity_id: "cloudbeds-scheduled-sync", detail: { sent: true, sent_by: "j" }, created_at: NOW },
      report("cloudbeds-scheduled-sync", "missing", 300),
      report("think-scheduled-sync", "missing", 10),
      { event_type: ALERT_CHANNEL_EVENT, entity_id: "bad", detail: { state: "odd" }, created_at: NOW },
    ]);
    expect(facts.reports).toEqual([
      { fn: "cloudbeds-scheduled-sync", state: "ready", minSeverity: "warn", reportedAt: expect.any(String), source: "secrets" },
      { fn: "think-scheduled-sync", state: "missing", minSeverity: "critical", reportedAt: expect.any(String), source: "secrets" },
    ]);
    expect(facts.lastTest).toMatchObject({ fn: "cloudbeds-scheduled-sync", sent: true, sentBy: "j", reason: null });
  });

  it("reads unknown, ready, missing, not https and stale", () => {
    expect(describeAlertChannel({ reports: [], lastTest: null }, NOW)).toMatchObject({ verdict: "unknown", severity: "amber", test: null });
    expect(describeAlertChannel(alertChannelFacts([report("cloudbeds-scheduled-sync", "ready", 3)]), NOW)).toMatchObject({
      verdict: "ready",
      severity: "emerald",
      text: "Alerts: ready. cloudbeds-scheduled-sync said 3m ago that its alerts have somewhere to go (critical alerts only).",
    });
    expect(
      describeAlertChannel(alertChannelFacts([report("cloudbeds-scheduled-sync", "ready", 3), report("think-scheduled-sync", "not_https", 4)]), NOW),
    ).toMatchObject({
      verdict: "missing",
      severity: "rose",
      text: expect.stringContaining("think-scheduled-sync said 4m ago that MAYA_ALERT_WEBHOOK in the Supabase function secrets is not an https:// address"),
    });
    expect(describeAlertChannel(alertChannelFacts([report("cloudbeds-scheduled-sync", "ready", 13 * 60, "warn")]), NOW)).toMatchObject({
      verdict: "stale",
      severity: "amber",
      text: expect.stringContaining("Alerts: stale. The last word on the alert channel was from cloudbeds-scheduled-sync, 13h ago: ready, warnings and critical alerts."),
    });
    // Within two intervals it is current.
    expect(describeAlertChannel(alertChannelFacts([report("cloudbeds-scheduled-sync", "ready", 11 * 60)]), NOW)).toMatchObject({ verdict: "ready" });
    for (const line of [describeAlertChannel({ reports: [], lastTest: null }, NOW)]) expect(line.text).not.toContain("—");
  });

  it("the database watchdog reports too, and a missing address there names the Vault secret, not the function secrets", () => {
    const watchdog = (state: string, minutesAgo: number) => ({
      event_type: ALERT_CHANNEL_EVENT,
      entity_id: "pricing-watchdog",
      detail: { fn: "pricing-watchdog", state, min_severity: "critical", source: "vault" },
      created_at: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString(),
    });
    const facts = alertChannelFacts([report("cloudbeds-scheduled-sync", "ready", 3), watchdog("missing", 2)]);
    expect(facts.reports.find((r) => r.fn === "pricing-watchdog")).toMatchObject({ source: "vault", state: "missing" });
    expect(describeAlertChannel(facts, NOW)).toMatchObject({
      verdict: "missing",
      severity: "rose",
      text: "Alerts: missing. pricing-watchdog said 2m ago that the Vault secret maya_alert_webhook is not set (the database watchdog reads its address from Vault, not the function secrets), so the alerts it raises are being skipped.",
    });
    expect(describeAlertChannel(alertChannelFacts([report("cloudbeds-scheduled-sync", "ready", 3), watchdog("not_https", 2)]), NOW).text).toContain(
      "the Vault secret maya_alert_webhook is not an https:// address",
    );
    expect(describeAlertChannel(alertChannelFacts([report("cloudbeds-scheduled-sync", "ready", 3), watchdog("ready", 2)]), NOW)).toMatchObject({
      verdict: "ready",
      text: "Alerts: ready. pricing-watchdog said 2m ago that its alerts have somewhere to go (critical alerts only).",
    });
  });
});
