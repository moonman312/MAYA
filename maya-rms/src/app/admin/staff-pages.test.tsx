/**
 * Every Command Center page checks its own section on the server, for every
 * role: a platform admin gets them all, a developer only Docs Questions,
 * Users, PMS Access, Pilot Health and Hotels (with each property's page),
 * sales only Analytics, Hotels, Stalled Signups, Pilot Health and Docs
 * Questions, and a developer or sales login before its code gets the code
 * step. The layout turns away anyone who is not staff past the code and
 * hands the nav the role's sections. Found by globbing, so a new page with no
 * check fails here.
 */
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { STAFF_ROLE_SECTIONS, type StaffRole, type StaffSection } from "@/lib/admin/staff-sections";
import type { StaffSession } from "@/lib/admin/staff-session";

const state = vi.hoisted(() => ({ session: null as unknown }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/admin/staff-session", () => ({
  getStaffSession: async () => state.session,
  staffCanSee: (session: StaffSession, section: StaffSection) => session.ok && session.sections.includes(section),
}));
// Anything a page reads after its check stops the page here: past the gate.
const pastGate = () => {
  throw new Error("PAST_GATE");
};
vi.mock("@/utils/supabase/server", () => ({ createClient: pastGate }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: pastGate, isAdminConfigured: () => true }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/admin/analytics-cache", () => ({ analyticsClock: pastGate }));
vi.mock("@/components/admin/admin-top-nav", () => ({ AdminTopNav: () => null }));
vi.mock("@/components/admin/god-mode-banner-slot", () => ({ GodModeBannerSlot: () => null }));

type PageModule = { default: (props: unknown) => Promise<unknown> | unknown };
/** Every page.tsx under /admin, as "./hotels/[hotelId]/page.tsx". */
const PAGES: Record<string, () => Promise<PageModule>> = Object.fromEntries(
  readdirSync(__dirname, { recursive: true, encoding: "utf8" })
    .filter((f) => basename(f) === "page.tsx")
    .map((f) => [`./${f.split("\\").join("/")}`, () => import(/* @vite-ignore */ resolve(__dirname, f)) as Promise<PageModule>]),
);

/** Each page and the section it belongs to. */
const PAGE_SECTIONS: Record<string, StaffSection> = {
  "./page.tsx": "home",
  "./analytics/page.tsx": "analytics",
  "./docs-questions/page.tsx": "docs_questions",
  "./hotels/page.tsx": "hotels",
  "./hotels/[hotelId]/page.tsx": "hotels",
  "./hotels/new/page.tsx": "hotel_create",
  "./pending-invites/page.tsx": "pending_invites",
  "./pilot-health/page.tsx": "pilot_health",
  "./pms-access/page.tsx": "pms_access",
  "./signup-codes/page.tsx": "signup_codes",
  "./stalled-signups/page.tsx": "stalled_signups",
  "./users/page.tsx": "users",
};

function staff(role: StaffRole): StaffSession {
  return {
    ok: true,
    userId: "u1",
    email: "staff@example.com",
    role,
    aal: role === "platform_admin" ? "aal1" : "aal2",
    sections: [...STAFF_ROLE_SECTIONS[role]],
    isPlatformAdmin: role === "platform_admin",
  };
}

async function open(path: string): Promise<string> {
  const mod = await PAGES[path]();
  try {
    await mod.default({ params: Promise.resolve({ hotelId: "h1" }), searchParams: Promise.resolve({}) });
    return "in";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message === "PAST_GATE" ? "in" : message;
  }
}

beforeEach(() => {
  state.session = null;
});

describe("Command Center pages", () => {
  it("are all known here, each with its section", () => {
    expect(Object.keys(PAGES).sort()).toEqual(Object.keys(PAGE_SECTIONS).sort());
  });

  const EXPECTED: Record<StaffRole, string[]> = {
    platform_admin: Object.keys(PAGE_SECTIONS),
    developer: [
      "./page.tsx",
      "./docs-questions/page.tsx",
      "./hotels/page.tsx",
      "./hotels/[hotelId]/page.tsx",
      "./pilot-health/page.tsx",
      "./pms-access/page.tsx",
      "./users/page.tsx",
    ],
    sales: [
      "./page.tsx",
      "./analytics/page.tsx",
      "./docs-questions/page.tsx",
      "./hotels/page.tsx",
      "./hotels/[hotelId]/page.tsx",
      "./pilot-health/page.tsx",
      "./stalled-signups/page.tsx",
    ],
  };

  for (const role of ["platform_admin", "developer", "sales"] as const) {
    it(`let ${role} into exactly its pages and send it home from the rest`, async () => {
      state.session = staff(role);
      const opened: string[] = [];
      for (const path of Object.keys(PAGE_SECTIONS)) {
        const result = await open(path);
        if (result === "in") opened.push(path);
        else expect([path, result]).toEqual([path, "REDIRECT /admin"]);
      }
      expect(opened.sort()).toEqual([...EXPECTED[role]].sort());
    });
  }

  it("send a developer or sales login to the code step before its code, from every page", async () => {
    for (const role of ["developer", "sales"] as const) {
      state.session = { ok: false, reason: "mfa_required", userId: "u1", email: "x@example.com", role };
      for (const path of Object.keys(PAGE_SECTIONS)) expect([path, await open(path)]).toEqual([path, "REDIRECT /admin-code"]);
    }
  });

  it("send someone signed out to sign in, and a login with no staff role to the app", async () => {
    state.session = { ok: false, reason: "signed_out" };
    expect(await open("./users/page.tsx")).toBe("REDIRECT /login?next=/admin");
    state.session = { ok: false, reason: "not_staff", userId: "u1", email: "x@example.com" };
    expect(await open("./hotels/page.tsx")).toBe("REDIRECT /");
  });
});

describe("the Command Center layout", () => {
  async function layout(): Promise<string | ReactElement> {
    const { default: AdminLayout } = await import("./layout");
    try {
      return (await AdminLayout({ children: null })) as ReactElement;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  it("sends a developer or sales login before its code to the code step, which is outside /admin", async () => {
    state.session = { ok: false, reason: "mfa_required", userId: "u1", email: "x@example.com", role: "sales" };
    expect(await layout()).toBe("REDIRECT /admin-code");
  });

  it("sends someone signed out to sign in and a non-staff login to the app", async () => {
    state.session = { ok: false, reason: "signed_out" };
    expect(await layout()).toBe("REDIRECT /login?next=/admin");
    state.session = { ok: false, reason: "not_staff", userId: "u1", email: "x@example.com" };
    expect(await layout()).toBe("REDIRECT /");
  });

  it("hands the nav the role and its sections, and the God Mode banner only to a platform admin", async () => {
    for (const role of ["platform_admin", "developer", "sales"] as const) {
      state.session = staff(role);
      const tree = (await layout()) as ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>;
      const [nav, , banner] = tree.props.children;
      expect(nav.props).toEqual({ userEmail: "staff@example.com", role, sections: STAFF_ROLE_SECTIONS[role] });
      expect(banner.props).toEqual({ isPlatformAdmin: role === "platform_admin" });
    }
  });
});
