"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function InviteRowActions({
  pendingId,
  email,
}: {
  pendingId: string;
  email: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function run(action: "resend" | "revoke") {
    setMsg(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/pending-invites/${pendingId}`, {
        method: action === "revoke" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "resend" ? JSON.stringify({ email }) : undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        setMsg(body.error ?? "Failed");
        return;
      }
      setMsg(action === "resend" ? "Resent" : "Revoked");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => run("resend")}
        disabled={pending}
        className="rounded border border-slate-700 px-2 py-1 text-xs hover:border-slate-500 disabled:opacity-60"
      >
        Resend
      </button>
      <button
        type="button"
        onClick={() => run("revoke")}
        disabled={pending}
        className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:border-rose-400 disabled:opacity-60"
      >
        Revoke
      </button>
      {msg && <span className="text-xs text-slate-400">{msg}</span>}
    </div>
  );
}
