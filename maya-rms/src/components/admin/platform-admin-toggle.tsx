"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function PlatformAdminToggle({
  userId,
  isAdmin,
}: {
  userId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState(isAdmin);

  async function toggle() {
    setError(null);
    const next = !local;
    setLocal(next);
    startTransition(async () => {
      const res = await fetch(`/api/admin/users/${userId}/platform-admin`, {
        method: next ? "PUT" : "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        setError(body.error ?? "Request failed");
        setLocal(!next);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={local}
        aria-label="Toggle platform admin"
        onClick={toggle}
        disabled={pending}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition ${
          local ? "bg-sky-500" : "bg-slate-700"
        } ${pending ? "opacity-60" : ""}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
            local ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      {error && <span className="text-xs text-rose-300">{error}</span>}
    </div>
  );
}
