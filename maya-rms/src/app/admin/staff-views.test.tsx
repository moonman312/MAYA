/**
 * What each role sees on the Command Center pages it shares with a platform
 * admin. The home page shows only tiles the role may read (and never money),
 * the Hotels list shows plan, rooms, billing status, PMS and mode to all and
 * MRR only to a role with business numbers, Users gives a platform admin the
 * role picker and everyone else words, PMS Access gives a developer the gates
 * in words, Stalled Signups gives sales the email link but not the flag, and
 * Analytics gives sales no test toggle and no Refresh. Nothing a role may not
 * read is asked of the database.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAFF_ROLE_SECTIONS, type StaffRole } from "@/lib/admin/staff-sections";

const state = vi.hoisted(() => ({
  role: "platform_admin" as "platform_admin" | "developer" | "sales",
  calls: [] as string[],
  gatesClient: "" as string,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/admin/staff-page", () => ({
  requireStaffPage: async () => ({
    ok: true,
    userId: "u1",
    email: "staff@example.com",
    role: state.role,
    aal: "aal2",
    sections: [...STAFF_ROLE_SECTIONS[state.role]],
    isPlatformAdmin: state.role === "platform_admin",
  }),
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => ({ kind: "session" }) }));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => (state.calls.push("service role"), { kind: "service" }),
}));

const HOTEL = {
  id: "h1",
  name: "Harbour Inn",
  timezone: "UTC",
  currency: "USD",
  is_active: true,
  setup_pending_at: null,
  is_test: false,
  total_rooms_per_type: 10,
  external_enterprise_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  pms_type: "cloudbeds",
  pms_status: "connected",
  pms_last_sync_at: new Date().toISOString(),
  membership_count: 2,
  simulation_mode: true,
  billing_status: "trialing",
  plan_kind: "stripe",
  billing_interval: "year",
  billed_rooms: 18,
  measured_rooms: 18,
  list_mrr_cents: 54000,
};
vi.mock("@/lib/admin/hotels", () => ({
  listHotels: async () => (state.calls.push("listHotels"), [{ ...HOTEL, list_mrr_cents: state.role === "developer" ? null : HOTEL.list_mrr_cents }]),
}));
vi.mock("@/lib/admin/users", () => ({
  countPlatformUsers: async () => (state.calls.push("countPlatformUsers"), 7),
  listPlatformUsers: async () => (
    state.calls.push("listPlatformUsers"),
    [
      {
        id: "u-dev",
        email: "developer@example.com",
        full_name: null,
        is_active: true,
        created_at: "2026-09-30T00:00:00Z",
        last_sign_in_at: null,
        platform_roles: ["developer"],
        hotel_count: 1,
      },
    ]
  ),
}));
vi.mock("@/lib/admin/memberships", () => ({
  listPendingInvites: async () => (state.calls.push("listPendingInvites"), []),
}));
vi.mock("@/lib/admin/signup-codes", () => ({
  countSignupCodes: async () => (state.calls.push("countSignupCodes"), 3),
}));
vi.mock("@/lib/admin/docs-tally", () => ({
  loadTallyTotals: async () => (state.calls.push("loadTallyTotals"), null),
}));
vi.mock("@/components/admin/docs-tally-panels", () => ({ DocsTallyTile: () => <i data-c="docs-tally" /> }));
vi.mock("@/components/admin/test-alert-button", () => ({ TestAlertButton: () => <i data-c="test-alert" /> }));
vi.mock("@/components/admin/staff-role-picker", () => ({
  StaffRolePicker: ({ role }: { role: string }) => <i data-c="role-picker" data-role={role} />,
}));
vi.mock("@/lib/billing/pms-gates", () => ({
  listPmsSignupGates: async (client: { kind: string }) => (
    (state.gatesClient = client.kind), [{ pmsType: "cloudbeds", requiresSignupCode: false, updatedAt: null }]
  ),
}));
vi.mock("@/lib/pms/registry", () => ({
  listPmsStatuses: () => [
    { type: "cloudbeds", displayName: "Cloudbeds" },
    { type: "think", displayName: "Think Reservations" },
  ],
}));
vi.mock("@/components/admin/pms-signup-gate-toggle", () => ({ PmsSignupGateToggle: () => <i data-c="gate-toggle" /> }));
vi.mock("@/lib/admin/stalled-signups", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin/stalled-signups")>()),
  listStalledSignups: async () => [
    {
      hotel_id: "h9",
      hotel_name: "Stuck Lodge",
      headline: "Paid, never connected",
      severity: "burning",
      stuck_hours: 80,
      signup_abandoned_at: null,
      signup_abandoned_note: null,
      admin_email: "gm@stuck.example",
      admin_name: null,
      email_confirmed: true,
      reachable: true,
      billed_rooms: 12,
      rooms_measured: null,
      monthly_cents: 36000,
      signup_code: null,
      pms_type: null,
      pms_status: null,
      created_at: "2026-09-01T00:00:00Z",
      last_sign_in_at: null,
      status: "active",
      trial_end: null,
      periods_billed: 2,
      spent_cents: 72000,
      current_period_end: null,
      card_verify_last_code: null,
      import_error: null,
      import_status: null,
      import_phase: null,
      action: "Call them.",
    },
  ],
}));
vi.mock("@/components/admin/stalled-signup-actions", () => ({ StalledSignupActions: () => <i data-c="flag-actions" /> }));
vi.mock("@/lib/admin/analytics-cache", () => ({ analyticsClock: () => ({ slot: 1, today: "2026-09-30" }) }));
vi.mock("@/components/admin/analytics-refresh", () => ({ AnalyticsRefresh: () => <i data-c="refresh" /> }));
vi.mock("@/components/admin/analytics-range-picker", () => ({
  AnalyticsRangePicker: ({ includeTest }: { includeTest: boolean }) => <i data-c="range" data-test={String(includeTest)} />,
}));
vi.mock("./analytics/sections", () => {
  const marker = (name: string) => {
    const Marker = (p: { includeTest?: boolean }) => <i data-c={name} data-test={String(p.includeTest)} />;
    Marker.displayName = name;
    return Marker;
  };
  return {
    AsOf: marker("as-of"),
    Charts: marker("charts"),
    ChartsSkeleton: () => null,
    EventTables: marker("events"),
    EventTablesSkeleton: () => null,
    GainedLostTile: marker("gained-lost"),
    NeedsAttention: marker("attention"),
    NowTiles: marker("now"),
    PanelSkeleton: () => null,
    Product: marker("product"),
    ProductSkeleton: () => null,
    PushProblems: marker("push"),
    RevenueBySize: marker("by-size"),
    Signups: marker("signups"),
    TileSkeleton: () => null,
  };
});

const { default: HomePage } = await import("./page");
const { default: HotelsPage } = await import("./hotels/page");
const { default: UsersPage } = await import("./users/page");
const { default: PmsAccessPage } = await import("./pms-access/page");
const { default: StalledPage } = await import("./stalled-signups/page");
const { default: AnalyticsPage } = await import("./analytics/page");

async function html(role: StaffRole, page: () => Promise<React.ReactElement> | React.ReactElement): Promise<string> {
  state.role = role;
  return renderToStaticMarkup(await page());
}

beforeEach(() => {
  state.calls = [];
  state.gatesClient = "";
});

describe("the home page", () => {
  it("gives a platform admin every tile, New hotel and the test alert", async () => {
    const out = await html("platform_admin", () => HomePage());
    for (const label of ["Hotels", "PMS connected", "Users", "Pending invites", "Stale syncs", "Signup codes"]) {
      expect(out).toContain(`>${label}</div>`);
    }
    expect(out).toContain("+ New hotel");
    expect(out).toContain('data-c="test-alert"');
    expect(out).toContain('data-c="docs-tally"');
  });

  it("gives a developer no invites, codes, New hotel, test alert or money, and asks for none of it", async () => {
    const out = await html("developer", () => HomePage());
    for (const label of ["Hotels", "PMS connected", "Users", "Stale syncs"]) expect(out).toContain(`>${label}</div>`);
    for (const label of ["Pending invites", "Signup codes"]) expect(out).not.toContain(`>${label}</div>`);
    expect(out).not.toContain("+ New hotel");
    expect(out).not.toContain('data-c="test-alert"');
    expect(out).not.toMatch(/\$\d|MRR|revenue/i);
    expect(out).toContain('data-c="docs-tally"');
    expect(state.calls).not.toContain("listPendingInvites");
    expect(state.calls).not.toContain("countSignupCodes");
  });

  it("gives sales no Users tile and never asks for the count", async () => {
    const out = await html("sales", () => HomePage());
    expect(out).not.toContain(">Users</div>");
    expect(out).toContain(">Hotels</div>");
    expect(state.calls).not.toContain("countPlatformUsers");
    expect(state.calls).not.toContain("listPendingInvites");
  });
});

describe("the Hotels list", () => {
  it("shows every role the plan, rooms, billing status, PMS and mode", async () => {
    for (const role of ["platform_admin", "developer", "sales"] as const) {
      const out = await html(role, () => HotelsPage());
      for (const word of ["Annual", ">18<", "Trial", "cloudbeds", "Simulation"]) expect([role, out.includes(word)]).toEqual([role, true]);
    }
  });

  it("shows MRR to a platform admin and sales, never to a developer", async () => {
    expect(await html("platform_admin", () => HotelsPage())).toContain("$540");
    expect(await html("sales", () => HotelsPage())).toContain("$540");
    const dev = await html("developer", () => HotelsPage());
    expect(dev).not.toContain("MRR");
    expect(dev).not.toContain("$");
  });

  it("offers New hotel to a platform admin only", async () => {
    expect(await html("platform_admin", () => HotelsPage())).toContain("+ New hotel");
    expect(await html("developer", () => HotelsPage())).not.toContain("+ New hotel");
    expect(await html("sales", () => HotelsPage())).not.toContain("+ New hotel");
  });
});

describe("the Users page", () => {
  const props = { searchParams: Promise.resolve({}) };

  it("gives a platform admin the role picker, set to each person's role", async () => {
    const out = await html("platform_admin", () => UsersPage(props));
    expect(out).toContain('data-c="role-picker" data-role="developer"');
  });

  it("gives a developer the role in words and no picker", async () => {
    const out = await html("developer", () => UsersPage(props));
    expect(out).not.toContain("role-picker");
    expect(out).toContain(">Developer</span>");
    expect(out).not.toMatch(/<(button|input|select|form)\b/);
  });
});

describe("PMS Access", () => {
  it("gives a platform admin the switches, read with the service role", async () => {
    const out = await html("platform_admin", () => PmsAccessPage());
    expect(out).toContain('data-c="gate-toggle"');
    expect(state.gatesClient).toBe("service");
  });

  it("gives a developer the gates in words, read under his own session, with no switch", async () => {
    const out = await html("developer", () => PmsAccessPage());
    expect(out).not.toContain("gate-toggle");
    expect(out).not.toMatch(/<(button|input|select|form)\b/);
    expect(out).toContain("Open to anyone");
    expect(out).toContain("Code needed");
    expect(state.gatesClient).toBe("session");
    expect(state.calls).not.toContain("service role");
  });
});

describe("Stalled Signups", () => {
  const props = { searchParams: Promise.resolve({}) };

  it("gives a platform admin the flag", async () => {
    expect(await html("platform_admin", () => StalledPage(props))).toContain('data-c="flag-actions"');
  });

  it("gives sales the email link and no flag", async () => {
    const out = await html("sales", () => StalledPage(props));
    expect(out).not.toContain("flag-actions");
    expect(out).toContain("mailto:gm@stuck.example");
    expect(out).not.toMatch(/<(button|input|select|form)\b/);
  });
});

describe("Analytics", () => {
  const props = (test?: string) => ({ searchParams: Promise.resolve(test ? { test } : {}) });

  it("gives a platform admin the test toggle and Refresh, and counts test properties when asked", async () => {
    const out = await html("platform_admin", () => AnalyticsPage(props("1")));
    expect(out).toContain('data-c="refresh"');
    expect(out).toContain("Hide test properties");
    expect(out).toContain('data-c="now" data-test="true"');
  });

  it("counts customers only for sales, whatever the address asks, with no toggle and no Refresh", async () => {
    const out = await html("sales", () => AnalyticsPage(props("1")));
    expect(out).not.toContain('data-c="refresh"');
    expect(out).not.toContain("test properties");
    expect(out).not.toContain('data-test="true"');
    expect(out).toContain('data-c="now" data-test="false"');
  });
});
