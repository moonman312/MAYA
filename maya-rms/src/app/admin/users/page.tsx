import { PlatformAdminToggle } from "@/components/admin/platform-admin-toggle";
import { listPlatformUsers } from "@/lib/admin/users";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function AdminUsersPage() {
  const ssr = createClient(await cookies());
  const users = await listPlatformUsers(ssr);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-slate-400">{users.length} accounts across the platform</p>
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
