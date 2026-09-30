import { PlatformAdminToggle } from "@/components/admin/platform-admin-toggle";
import { countPlatformUsers, listPlatformUsers } from "@/lib/admin/users";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";

/** Accounts per page; platform_list_users stops at 500. */
const PER_PAGE = 100;

export const dynamic = "force-dynamic";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const params = await searchParams;
  const page = Math.max(1, Math.floor(Number(params.page)) || 1);
  const ssr = createClient(await cookies());
  // The page and the total together: one wait.
  const [users, total] = await Promise.all([
    listPlatformUsers(ssr, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE }),
    countPlatformUsers(ssr),
  ]);
  const pages = total == null ? null : Math.max(1, Math.ceil(total / PER_PAGE));
  // Without the total (before the speed migration), a full page means there may be more.
  const hasNext = pages == null ? users.length === PER_PAGE : page < pages;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-slate-400">
            {total ?? users.length} account{(total ?? users.length) === 1 ? "" : "s"} across the platform
          </p>
        </div>
        {(page > 1 || hasNext) && (
          <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
            {page > 1 ? (
              <Link href={`/admin/users?page=${page - 1}`} className="text-sky-300 hover:underline">
                Newer
              </Link>
            ) : (
              <span className="text-slate-600">Newer</span>
            )}
            <span className="text-slate-400">
              Page {page}
              {pages != null ? ` of ${pages}` : ""}
            </span>
            {hasNext ? (
              <Link href={`/admin/users?page=${page + 1}`} className="text-sky-300 hover:underline">
                Older
              </Link>
            ) : (
              <span className="text-slate-600">Older</span>
            )}
          </nav>
        )}
      </div>

      <div className="overflow-hidden rounded border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Hotels</th>
              <th className="px-4 py-3">Roles</th>
              <th className="px-4 py-3">Last sign in</th>
              <th className="px-4 py-3">Platform admin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {users.map((u) => {
              const isPlatformAdmin = (u.platform_roles ?? []).includes("platform_admin");
              return (
                <tr key={u.id} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-medium text-slate-100">{u.email}</td>
                  <td className="px-4 py-3 text-slate-300">{u.full_name ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-300">{u.hotel_count}</td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {(u.platform_roles ?? []).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{formatDate(u.last_sign_in_at)}</td>
                  <td className="px-4 py-3">
                    <PlatformAdminToggle userId={u.id} isAdmin={isPlatformAdmin} />
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
