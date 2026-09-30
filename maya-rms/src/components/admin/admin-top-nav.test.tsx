/**
 * The Command Center's top nav, rendered to markup: the Pilot health entry is
 * there and lit on its own page, and each role sees only its own pages. Only
 * a platform admin gets the God Mode button; a developer or sales login is
 * named by its role instead.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { STAFF_ROLE_SECTIONS } from "@/lib/admin/staff-sections";

const nav = vi.hoisted(() => ({ pathname: "/admin" }));

vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("next/link", () => ({
  default: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/brand/logo", () => ({ MayaMark: () => null }));
// The nav also carries the God Mode button, which is its own component with its own tests.
vi.mock("@/components/admin/god-mode-button", () => ({ GodModeButton: () => <button>God Mode</button> }));

const { AdminTopNav, navLinksFor } = await import("./admin-top-nav");

const link = (html: string, href: string) => html.match(new RegExp(`<a href="${href}"[^>]*>[^<]*</a>`))?.[0] ?? "";
const hrefs = (html: string) => [...html.matchAll(/<a href="(\/admin[^"]*)"/g)].map((m) => m[1]);

function render(role: "platform_admin" | "developer" | "sales") {
  return renderToStaticMarkup(<AdminTopNav userEmail="ops@example.com" role={role} sections={STAFF_ROLE_SECTIONS[role]} />);
}

describe("AdminTopNav", () => {
  it("lists Pilot health, and lights it on its own page", () => {
    nav.pathname = "/admin/pilot-health";
    const html = render("platform_admin");
    const entry = link(html, "/admin/pilot-health");
    expect(entry).toContain(">Pilot health</a>");
    expect(entry).toContain("bg-slate-800 text-slate-100");
    expect(link(html, "/admin/analytics")).not.toContain("bg-slate-800 text-slate-100");
  });

  it("gives a platform admin every page and the God Mode button", () => {
    nav.pathname = "/admin";
    const html = render("platform_admin");
    expect(navLinksFor(STAFF_ROLE_SECTIONS.platform_admin)).toHaveLength(10);
    for (const href of [
      "/admin/hotels",
      "/admin/analytics",
      "/admin/pilot-health",
      "/admin/users",
      "/admin/pending-invites",
      "/admin/signup-codes",
      "/admin/pms-access",
      "/admin/stalled-signups",
      "/admin/docs-questions",
    ]) {
      expect(link(html, href)).not.toBe("");
    }
    expect(html).toContain(">God Mode</button>");
  });

  it("gives a developer Docs Questions, Users, PMS Access, Pilot Health and Hotels, and no God Mode", () => {
    const html = render("developer");
    expect(navLinksFor(STAFF_ROLE_SECTIONS.developer).map((l) => l.href)).toEqual([
      "/admin",
      "/admin/hotels",
      "/admin/pilot-health",
      "/admin/users",
      "/admin/pms-access",
      "/admin/docs-questions",
    ]);
    for (const href of ["/admin/analytics", "/admin/pending-invites", "/admin/signup-codes", "/admin/stalled-signups"]) {
      expect(link(html, href)).toBe("");
    }
    expect(html).not.toContain("God Mode");
    expect(html).toContain(">Developer</span>");
    expect(hrefs(html)).not.toContain("/admin/analytics");
  });

  it("gives sales Analytics, Hotels, Stalled Signups, Pilot Health and Docs Questions, and no God Mode", () => {
    const html = render("sales");
    expect(navLinksFor(STAFF_ROLE_SECTIONS.sales).map((l) => l.href)).toEqual([
      "/admin",
      "/admin/hotels",
      "/admin/analytics",
      "/admin/pilot-health",
      "/admin/stalled-signups",
      "/admin/docs-questions",
    ]);
    for (const href of ["/admin/users", "/admin/pending-invites", "/admin/signup-codes", "/admin/pms-access"]) {
      expect(link(html, href)).toBe("");
    }
    expect(html).not.toContain("God Mode");
    expect(html).toContain(">Sales</span>");
  });

  it("offers a way to sign out", () => {
    expect(render("sales")).toContain('action="/auth/logout"');
  });
});
