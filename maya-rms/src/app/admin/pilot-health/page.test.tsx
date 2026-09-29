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
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({ rpc: async () => ({ data: state.rows, error: state.error }) }),
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
