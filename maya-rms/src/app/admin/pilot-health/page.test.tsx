/**
 * The Pilot health page rendered to markup: each property links to its
 * admin page, the ones with a problem come first, test properties are hidden
 * unless asked for (and the page says how many), and a deployment ahead of
 * its migration is told so in one line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PilotHealthRow } from "@/lib/admin/pilot-health-assess";

const state = vi.hoisted(() => ({
  rows: [] as PilotHealthRow[],
  error: null as { code: string; message: string } | null,
  /** platform_audit_events rows, newest first: what the scheduled syncs said about their alert channel. */
  auditRows: [] as Record<string, unknown>[],
  auditError: null as { message: string } | null,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
// Who may open the page is its own test (staff-pages.test.tsx); here, a platform admin.
vi.mock("@/lib/admin/staff-page", () => ({
  requireStaffPage: async () => ({ ok: true, role: "platform_admin", sections: ["pilot_health"], isPlatformAdmin: true }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    rpc: async () => ({ data: state.rows, error: state.error }),
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "in", "order"]) q[m] = () => q;
      q.limit = async () => ({ data: state.auditRows, error: state.auditError });
      return q;
    },
  }),
}));

const { default: PilotHealthPage } = await import("./page");

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const today = new Date().toISOString().slice(0, 10);

/** A property with nothing wrong, on a UTC clock so today's pass is today's. */
function healthy(o: Partial<PilotHealthRow> = {}): PilotHealthRow {
  return {
    hotel_id: "alpha",
    name: "Alpha Inn",
    timezone: "UTC",
    is_test: false,
    mode: "live",
    subscription_status: "active",
    pms_type: "mews",
    pms_status: "connected",
    last_sync_at: minutesAgo(3),
    down_since: null,
    sync_failures: 0,
    last_ok_run_at: minutesAgo(2),
    pass_date: today,
    pass_cursor: null,
    pass_started_at: minutesAgo(30),
    pass_completed_at: minutesAgo(20),
    pass_horizon_days: 396,
    dirty_count: 0,
    dirty_oldest_marked_at: null,
    sent_24h: 12,
    open_incidents: 0,
    open_incidents_since: null,
    open_incidents_admin_only: 0,
    open_incident_causes: [],
    active_rules: 3,
    rule_changes_24h: 1,
    unsent_count: 0,
    unsent_since: null,
    rate_read_waiting: 0,
    rate_read_waiting_since: null,
    ...o,
  };
}

async function render(test?: string): Promise<string> {
  return renderToStaticMarkup(await PilotHealthPage({ searchParams: Promise.resolve(test ? { test } : {}) }));
}

/** The page as text, with the markup stripped. */
const asText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

beforeEach(() => {
  state.rows = [];
  state.error = null;
  state.auditRows = [];
  state.auditError = null;
});

const channelReport = (fn: string, state_: string, minutes: number, minSeverity = "warn") => ({
  event_type: "alert.channel",
  entity_id: fn,
  detail: { fn, state: state_, min_severity: minSeverity },
  created_at: minutesAgo(minutes),
});

describe("the pilot health page", () => {
  it("links each property to its admin page and puts the one with a problem first", async () => {
    state.rows = [
      healthy(),
      healthy({ hotel_id: "beta", name: "Beta Inn", pms_status: "error", down_since: minutesAgo(180), last_sync_at: minutesAgo(180) }),
    ];
    const html = await render();
    expect(html).toContain('href="/admin/hotels/alpha"');
    expect(html).toContain('href="/admin/hotels/beta"');
    expect(html.indexOf("Beta Inn")).toBeLessThan(html.indexOf("Alpha Inn"));

    const text = asText(html);
    expect(text).toContain("The connection has been in Error for 3h.");
    expect(text).toContain("No successful read for 3h.");
    expect(text).toContain("Looks fine");
    expect(text).toContain("2 properties, 2 live, 0 simulating, 1 with a problem.");
    expect(text).toContain("No test properties hidden");
    expect(text).toContain("Reload to refresh.");
    expect(text).not.toContain("—");
  });

  it("shows the connection, pricing, sending and rules at a glance", async () => {
    state.rows = [
      healthy({
        mode: "simulation",
        dirty_count: 4,
        dirty_oldest_marked_at: minutesAgo(50),
        open_incidents: 1,
        open_incidents_since: minutesAgo(60),
        open_incident_causes: ["rate_not_found"],
        open_incidents_admin_only: 2,
      }),
    ];
    const text = asText(await render());
    expect(text).toContain("Simulation");
    expect(text).toContain("connected");
    expect(text).toContain("read 3m ago");
    expect(text).toContain("ran 2m ago");
    expect(text).toContain("Priced through");
    expect(text).toContain("4 in the queue");
    expect(text).toContain("12 sent in 24h");
    expect(text).toContain("1 open");
    expect(text).toContain("2 held by MAYA");
    expect(text).toContain("3 active");
    expect(text).toContain("1 changed in 24h");
    expect(text).toContain("1 open sending problem for 1h: rate not found.");
    expect(text).toContain("4 nights waiting to be priced, the oldest for 50m.");
  });

  it("does not call a Live property fine while its prices wait to be sent", async () => {
    // What the audit found reading "Looks fine": connected, read 3m ago, pass done, 0 sent in 24h.
    state.rows = [
      healthy({ pms_type: "cloudbeds", sent_24h: 0, unsent_count: 792, unsent_since: minutesAgo(180) }),
      healthy({ hotel_id: "beta", name: "Beta Inn", pms_type: "cloudbeds" }),
    ];

    const html = await render();
    const text = asText(html);

    expect(html.indexOf("Alpha Inn")).toBeLessThan(html.indexOf("Beta Inn"));
    expect(text).toContain("0 sent in 24h");
    expect(text).toContain("792 not sent after an hour");
    expect(text).toContain("792 published prices not sent after over an hour, the oldest for 3h.");
    expect(text).toContain("check MAYA_PUSH_RATES in the function settings");
    expect(text).toContain("2 properties, 2 live, 0 simulating, 1 with a problem.");
    expect(text).not.toContain("Run 99_supabase_migration_pilot_health_v2.sql");
  });

  it("shows nights waiting on a rate read, as a note for the first hour and a problem after it", async () => {
    const waiting = (minutes: number) =>
      healthy({
        pms_type: "cloudbeds",
        open_incidents: 1,
        open_incidents_since: minutesAgo(minutes),
        open_incident_causes: ["awaiting_rate_read"],
        rate_read_waiting: 40,
        rate_read_waiting_since: minutesAgo(minutes),
      });

    state.rows = [waiting(10)];
    const early = asText(await render());
    expect(early).toContain("40 waiting on a rate read");
    expect(early).toContain("Looks fine");

    state.rows = [waiting(75)];
    const late = asText(await render());
    expect(late).toContain("40 nights held for 1h until the hotel's own rates can be read.");
    expect(late).not.toContain("Looks fine");
  });

  it("says which file to run when the database cannot say whether prices are waiting", async () => {
    const old = healthy();
    delete old.unsent_count;
    delete old.unsent_since;
    delete old.rate_read_waiting;
    delete old.rate_read_waiting_since;
    state.rows = [old];

    const text = asText(await render());

    expect(text).toContain("Run 99_supabase_migration_pilot_health_v2.sql to see prices that were published and not sent.");
    expect(text).toContain("Alpha Inn");
  });

  it("hides test properties unless asked, and says how many it hid", async () => {
    state.rows = [healthy(), healthy({ hotel_id: "sandbox", name: "Sandbox Inn", is_test: true })];
    const hiddenHtml = await render();
    const hidden = asText(hiddenHtml);
    expect(hidden).not.toContain("Sandbox Inn");
    expect(hidden).toContain("1 test property hidden; show them");
    expect(hiddenHtml).toContain('href="/admin/pilot-health?test=1"');

    const shown = asText(await render("1"));
    expect(shown).toContain("Sandbox Inn");
    expect(shown).toContain("Test properties are included; hide them");
  });

  it("says which migration to run when the function is missing", async () => {
    state.error = { code: "PGRST202", message: "Could not find the function public.platform_pilot_health" };
    const html = await render();
    expect(asText(html)).toContain("Run 99_supabase_migration_pilot_health_v1.sql to see this.");
    expect(html).not.toContain("<table");
  });

  it("says when there is nothing to show", async () => {
    const text = asText(await render());
    expect(text).toContain("No live or simulating properties.");
  });
});

describe("the alerts line", () => {
  // The app's own MAYA_ALERT_WEBHOOK says nothing about the functions that
  // raise the real alerts, so the line reads what those functions reported.
  it("says not reported when no scheduled sync has said anything", async () => {
    state.rows = [healthy()];
    const html = await render();
    expect(html).toContain('data-alerts="unknown"');
    expect(asText(html)).toContain("Alerts: not reported.");
  });

  it("says ready from the newest report, with the severity floor", async () => {
    state.rows = [healthy()];
    state.auditRows = [channelReport("cloudbeds-scheduled-sync", "ready", 12), channelReport("think-scheduled-sync", "ready", 240, "critical")];
    const html = await render();
    expect(html).toContain('data-alerts="ready"');
    expect(asText(html)).toContain("Alerts: ready. cloudbeds-scheduled-sync said 12m ago that its alerts have somewhere to go (warnings and critical alerts).");
  });

  it("says missing when any function has nowhere to send, and names it", async () => {
    state.rows = [healthy()];
    state.auditRows = [
      channelReport("think-scheduled-sync", "ready", 5),
      channelReport("cloudbeds-scheduled-sync", "missing", 12),
      {
        event_type: "alert.channel_test",
        entity_id: "cloudbeds-scheduled-sync",
        detail: { fn: "cloudbeds-scheduled-sync", sent: false, reason: "no_webhook_configured", state: "missing" },
        created_at: minutesAgo(12),
      },
    ];
    const html = await render();
    expect(html).toContain('data-alerts="missing"');
    const text = asText(html);
    expect(text).toContain(
      "Alerts: missing. cloudbeds-scheduled-sync said 12m ago that MAYA_ALERT_WEBHOOK is not set in the Supabase function secrets, so the alerts it raises are being skipped.",
    );
    expect(text).toContain("Last test alert: not sent 12m ago through cloudbeds-scheduled-sync (no_webhook_configured).");
  });

  it("is shown even when the pilot health function is missing, and survives a failed read", async () => {
    state.error = { code: "PGRST202", message: "Could not find the function public.platform_pilot_health" };
    state.auditRows = [channelReport("cloudbeds-scheduled-sync", "ready", 3)];
    expect(asText(await render())).toContain("Alerts: ready.");

    state.error = null;
    state.rows = [healthy()];
    state.auditError = { message: "connection reset" };
    const text = asText(await render());
    expect(text).toContain("Alerts: not known.");
    expect(text).toContain("Looks fine");
  });
});

