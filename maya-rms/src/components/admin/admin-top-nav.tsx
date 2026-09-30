"use client";

import { GodModeButton } from "@/components/admin/god-mode-button";
import { MayaMark } from "@/components/brand/logo";
import {
  STAFF_ROLE_LABELS,
  sectionForAdminPath,
  type StaffRole,
  type StaffSection,
} from "@/lib/admin/staff-sections";
import Link from "next/link";
import { usePathname } from "next/navigation";

export const ADMIN_NAV_LINKS = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/hotels", label: "Hotels" },
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/pilot-health", label: "Pilot health" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/pending-invites", label: "Pending Invites" },
  { href: "/admin/signup-codes", label: "Signup Codes" },
  { href: "/admin/pms-access", label: "PMS Access" },
  { href: "/admin/stalled-signups", label: "Stalled Signups" },
  { href: "/admin/docs-questions", label: "Docs Questions" },
];

/** The nav entries a role sees: only the pages its sections allow. */
export function navLinksFor(sections: readonly StaffSection[]) {
  return ADMIN_NAV_LINKS.filter((link) => {
    const section = sectionForAdminPath(link.href);
    return section !== null && sections.includes(section);
  });
}

/**
 * The Command Center's top nav. Each role sees only its own pages, and only
 * a platform admin gets the God Mode button; a developer or sales login is
 * told it reads only. Hiding a link is for tidiness: every page checks its
 * own section on the server, and the database checks it again.
 */
export function AdminTopNav({
  userEmail,
  role,
  sections,
}: {
  userEmail: string;
  role: StaffRole;
  sections: readonly StaffSection[];
}) {
  const pathname = usePathname();
  const links = navLinksFor(sections);
  const isPlatformAdmin = role === "platform_admin";
  return (
    <header className="border-b border-slate-800 bg-slate-950">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            href="/admin"
            className="inline-flex items-center gap-2 rounded bg-sky-500/10 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-sky-300"
          >
            <MayaMark size={24} />
            Command Center
          </Link>
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            {links.map((link) => {
              const active = link.exact
                ? pathname === link.href
                : pathname === link.href || pathname.startsWith(link.href + "/");
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`rounded px-3 py-1.5 transition ${
                    active
                      ? "bg-slate-800 text-slate-100"
                      : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          {isPlatformAdmin ? (
            <GodModeButton compact />
          ) : (
            <span className="rounded border border-slate-700 px-2 py-1 text-slate-300" title="Read only">
              {STAFF_ROLE_LABELS[role]}
            </span>
          )}
          <span>{userEmail}</span>
          <Link
            href="/"
            className="rounded border border-slate-700 px-2 py-1 hover:border-slate-600 hover:text-slate-200"
          >
            ← Back to app
          </Link>
          <form action="/auth/logout" method="post">
            <button type="submit" className="cursor-pointer hover:text-slate-200">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
