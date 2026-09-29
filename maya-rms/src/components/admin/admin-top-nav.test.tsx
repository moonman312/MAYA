/**
 * The Command Center's top nav, rendered to markup: the Pilot health entry is
 * there, and it is the one lit on its own page.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

const { AdminTopNav } = await import("./admin-top-nav");

const link = (html: string, href: string) => html.match(new RegExp(`<a href="${href}"[^>]*>[^<]*</a>`))?.[0] ?? "";

describe("AdminTopNav", () => {
  it("lists Pilot health, and lights it on its own page", () => {
    nav.pathname = "/admin/pilot-health";
    const html = renderToStaticMarkup(<AdminTopNav userEmail="ops@example.com" />);
    const entry = link(html, "/admin/pilot-health");
    expect(entry).toContain(">Pilot health</a>");
    expect(entry).toContain("bg-slate-800 text-slate-100");
    expect(link(html, "/admin/analytics")).not.toContain("bg-slate-800 text-slate-100");
  });
});
