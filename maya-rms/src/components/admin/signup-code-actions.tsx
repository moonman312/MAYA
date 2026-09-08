"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * On/off, never delete — turning a code off leaves its redemptions and the
 * subscriptions attributed to it exactly where they are.
 */
export function SignupCodeActions({ codeId, isActive }: { codeId: string; isActive: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function toggle() {
    setMsg(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/signup-codes/${codeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !isActive }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(body.error ?? "Failed");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-rose-300">{msg}</span>}
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className={`rounded border px-2 py-1 text-xs disabled:opacity-60 ${
          isActive
            ? "border-slate-700 text-slate-300 hover:border-slate-500"
            : "border-emerald-500/40 text-emerald-300 hover:border-emerald-400"
        }`}
      >
        {isActive ? "Turn off" : "Turn back on"}
      </button>
    </div>
  );
}
