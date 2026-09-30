/**
 * The app's first page for MAYA staff. A platform admin or a sales login
 * with no property goes to the Command Center (which sends a sales login to
 * its code step), never to onboarding's payment form. A developer with no
 * property goes to onboarding like anyone else: his own test property comes
 * through the ordinary signup. Every staff login gets the Command Center link
 * on a property's dashboard; only a platform admin is treated as one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const state = vi.hoisted(() => ({
  role: null as string | null,
  hotelId: null as string | null,
  dashboard: null as Record<string, unknown> | null,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    rpc: async (fn: string) => (fn === "staff_role" ? { data: state.role, error: null } : { data: null, error: null }),
  }),
}));
vi.mock("@/lib/settings/profile-settings", () => ({ readTextSize: async () => null }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => state.hotelId }));
vi.mock("@/lib/deep-links/member-role", () => ({ memberRole: async () => "hotel_admin" }));
vi.mock("@/lib/admin/god-mode", () => ({ godModeStatus: async () => ({ active: false }) }));
vi.mock("@/components/admin/god-mode-banner-slot", () => ({ GodModeBannerSlot: () => null }));
vi.mock("@/components/dashboard", () => ({ Dashboard: () => null }));

const { default: Home } = await import("./page");

async function open(): Promise<string> {
  try {
    const page = (await Home({ searchParams: Promise.resolve({}) })) as ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>;
    state.dashboard = page.props.children[1].props;
    return "dashboard";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

beforeEach(() => {
  state.role = null;
  state.hotelId = null;
  state.dashboard = null;
});

describe("the app's first page", () => {
  it("sends a platform admin or sales login with no property to the Command Center, and everyone else to onboarding", async () => {
    for (const role of ["platform_admin", "sales"]) {
      state.role = role;
      expect([role, await open()]).toEqual([role, "REDIRECT /admin"]);
    }
    for (const role of ["developer", null]) {
      state.role = role;
      expect([role, await open()]).toEqual([role, "REDIRECT /onboarding"]);
    }
  });

  it("gives every staff login on its own property the Command Center link, and only an admin the admin's view", async () => {
    state.hotelId = "h-1";
    for (const role of ["platform_admin", "developer", "sales"]) {
      state.role = role;
      expect(await open()).toBe("dashboard");
      expect(state.dashboard).toMatchObject({ commandCenter: true, isPlatformAdmin: role === "platform_admin" });
    }
    state.role = null;
    expect(await open()).toBe("dashboard");
    expect(state.dashboard).toMatchObject({ commandCenter: false, isPlatformAdmin: false });
  });
});
