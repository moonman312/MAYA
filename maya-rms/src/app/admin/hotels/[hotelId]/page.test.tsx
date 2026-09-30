/**
 * A property's Command Center page for each role. A platform admin gets the
 * controls. A developer gets the same facts with no control on the page at
 * all (no button, switch, field or form, nothing that calls a route), the
 * team, no pending invites and no money. Sales gets no team and no controls,
 * and occupancy, ADR and revenue for a real property only. Nothing a role
 * may not read is asked of the database.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAFF_ROLE_SECTIONS, type StaffRole } from "@/lib/admin/staff-sections";
import type { AdminHotelRow } from "@/lib/admin/types";

const state = vi.hoisted(() => ({
  role: "platform_admin" as "platform_admin" | "developer" | "sales",
  hotel: null as unknown,
  calls: [] as string[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
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
vi.mock("@/utils/supabase/server", () => ({ createClient: () => ({}) }));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => (state.calls.push("service role"), {}),
}));
vi.mock("@/lib/admin/hotels", () => ({
  getHotel: async () => (state.calls.push("getHotel"), state.hotel),
  getHotelSimulationMode: async () => (state.calls.push("getHotelSimulationMode"), false),
}));
vi.mock("@/lib/admin/memberships", () => ({
  listHotelMemberships: async () => (
    state.calls.push("listHotelMemberships"),
    [
      {
        membership_id: "m1",
        user_id: "owner",
        email: "owner@hotel.example",
        full_name: "Olive Owner",
        role: "hotel_admin",
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
      },
    ]
  ),
  listPendingInvites: async () => (state.calls.push("listPendingInvites"), []),
}));
vi.mock("@/lib/pms/pricing-horizon", () => ({ hotelPricingHorizon: async () => 396 }));
vi.mock("@/lib/pms/registry", () => ({ listPmsStatuses: () => [] }));
// The admin's controls, each a marker: the page decides whether they are there.
vi.mock("@/components/admin/god-mode-button", () => ({ GodModeButton: () => <i data-c="god-mode" /> }));
vi.mock("@/components/admin/open-property-button", () => ({ OpenPropertyButton: () => <i data-c="open-property" /> }));
vi.mock("@/components/admin/simulation-mode-toggle", () => ({ SimulationModeToggle: () => <i data-c="simulation-toggle" /> }));
vi.mock("@/components/admin/hotel-test-toggle", () => ({ HotelTestToggle: () => <i data-c="test-toggle" /> }));
vi.mock("@/components/admin/hotel-pms-card", () => ({ HotelPmsCard: () => <i data-c="pms-card" /> }));
vi.mock("@/components/admin/hotel-memberships-card", () => ({ HotelMembershipsCard: () => <i data-c="members-card" /> }));
vi.mock("@/components/admin/hotel-business-numbers", () => ({
  BusinessNumbersFrame: ({ children }: { children: React.ReactNode }) => <div data-c="business-numbers">{children}</div>,
  HotelBusinessNumbers: () => <i data-c="business-figures" />,
}));

const { default: AdminHotelDetailPage } = await import("./page");

function hotelRow(o: Partial<AdminHotelRow> = {}): AdminHotelRow {
  return {
    id: "h1",
    name: "Harbour Inn",
    timezone: "America/New_York",
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
    pms_last_sync_at: "2026-09-30T12:00:00Z",
    membership_count: 1,
    simulation_mode: false,
    pricing_horizon_days: 396,
    billing_status: "past_due",
    plan_kind: "stripe",
    billing_interval: "month",
    billed_rooms: 24,
    trial_end: null,
    cancel_at_period_end: false,
    measured_rooms: 24,
    list_mrr_cents: null,
    net_mrr_cents: null,
    mrr_day: null,
    ...o,
  };
}

async function render(role: StaffRole): Promise<string> {
  state.role = role;
  const page = await AdminHotelDetailPage({
    params: Promise.resolve({ hotelId: "h1" }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(page);
}

const CONTROLS = ["god-mode", "open-property", "simulation-toggle", "test-toggle", "pms-card", "members-card"];

beforeEach(() => {
  state.hotel = hotelRow();
  state.calls = [];
});

describe("a property's page", () => {
  it("gives a platform admin every control and the business numbers", async () => {
    const html = await render("platform_admin");
    for (const c of CONTROLS) expect(html).toContain(`data-c="${c}"`);
    expect(html).toContain('data-c="business-figures"');
    expect(state.calls).toEqual(expect.arrayContaining(["listHotelMemberships", "listPendingInvites", "service role"]));
  });

  it("is read only for a developer: no control, nothing that sends, the team, no invites and no money", async () => {
    const html = await render("developer");
    for (const c of CONTROLS) expect(html).not.toContain(`data-c="${c}"`);
    expect(html).not.toMatch(/<(button|input|select|textarea|form)\b/);
    expect(html).not.toContain("/api/");
    expect(html).not.toContain("business-numbers");
    expect(html).not.toMatch(/\$\d|MRR|revenue/i);
    // The team, and the facts, in words.
    expect(html).toContain("owner@hotel.example");
    expect(html).toContain("Hotel Admin");
    expect(html).toContain("Live");
    expect(html).toContain("Past due");
    expect(html).toContain("Monthly");
    expect(html).toContain("Read only");
    expect(state.calls).toContain("listHotelMemberships");
    expect(state.calls).not.toContain("listPendingInvites");
    expect(state.calls).not.toContain("service role");
  });

  it("is read only for sales, with no team, and the business numbers on a real property", async () => {
    const html = await render("sales");
    for (const c of CONTROLS) expect(html).not.toContain(`data-c="${c}"`);
    expect(html).not.toMatch(/<(button|input|select|textarea|form)\b/);
    expect(html).toContain('data-c="business-figures"');
    expect(html).not.toContain("owner@hotel.example");
    expect(state.calls).not.toContain("listHotelMemberships");
    expect(state.calls).not.toContain("listPendingInvites");
    expect(state.calls).not.toContain("service role");
  });

  it("shows sales no numbers for a test property, and says why", async () => {
    state.hotel = hotelRow({ is_test: true });
    const html = await render("sales");
    expect(html).not.toContain('data-c="business-figures"');
    expect(html).toContain("Business numbers are shown for real properties only.");
  });

  it("still gives a platform admin the numbers for a test property", async () => {
    state.hotel = hotelRow({ is_test: true });
    expect(await render("platform_admin")).toContain('data-c="business-figures"');
  });

  it("reads the pricing mode off the hotel list's row for staff", async () => {
    state.hotel = hotelRow({ simulation_mode: true });
    expect(await render("developer")).toContain("Simulation");
  });
});
