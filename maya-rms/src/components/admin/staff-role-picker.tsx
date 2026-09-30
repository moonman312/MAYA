"use client";

import {
  STAFF_ROLE_CHOICES,
  STAFF_ROLE_LABELS,
  isStaffRoleChoice,
  type StaffRoleChoice,
} from "@/lib/admin/staff-sections";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * A person's MAYA staff role on the Users page: None, Developer, Sales or
 * Platform admin. Only rendered for a platform admin. The change needs God
 * Mode, and the database refuses to remove the last platform admin; either
 * refusal comes back in plain words and the picker goes back to what it was.
 */
export function StaffRolePicker({ userId, role, email }: { userId: string; role: StaffRoleChoice; email: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<StaffRoleChoice>(role);

  function change(next: StaffRoleChoice) {
    if (next === local) return;
    const before = local;
    setError(null);
    setLocal(next);
    startTransition(async () => {
      const res = await fetch(`/api/admin/users/${userId}/staff-role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: next }),
      }).catch(() => null);
      if (!res || !res.ok) {
        const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
        setError(body.error ?? "Could not reach the server.");
        setLocal(before);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={local}
        aria-label={`Staff role for ${email}`}
        disabled={pending}
        onChange={(e) => {
          if (isStaffRoleChoice(e.target.value)) change(e.target.value);
        }}
        className="rounded bg-slate-950 p-1 text-xs text-slate-100 disabled:opacity-60"
      >
        {STAFF_ROLE_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {STAFF_ROLE_LABELS[choice]}
          </option>
        ))}
      </select>
      {error && <span className="max-w-xs text-xs text-rose-300">{error}</span>}
    </div>
  );
}
