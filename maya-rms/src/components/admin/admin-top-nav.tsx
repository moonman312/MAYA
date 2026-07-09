"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/hotels", label: "Hotels" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/pending-invites", label: "Pending Invites" },
];

export function AdminTopNav({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  return (
    <header className="border-b border-slate-800 bg-slate-950">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            href="/admin"
            className="rounded bg-sky-500/10 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-sky-300"
          >
            MAYA · Command Center
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
          <span>{userEmail}</span>
          <Link
            href="/"
            className="rounded border border-slate-700 px-2 py-1 hover:border-slate-600 hover:text-slate-200"
          >
            ← Back to app
          </Link>
        </div>
      </div>
    </header>
  );
}
