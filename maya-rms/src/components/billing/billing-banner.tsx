"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Status = {
  applicable: boolean;
  entitled?: boolean;
  tone?: "ok" | "warn" | "stopped";
  title?: string;
  detail?: string;
};

/**
 * Dashboard banner for a subscription that needs attention.
 *
 * Silent while everything is fine — a permanent "you are paid up" strip trains
 * people to ignore the space, which is exactly where the message that matters
 * has to appear. The one case it must never miss is work having stopped: the
 * calendar keeps rendering yesterday's prices, so without this the property
 * looks like it is still working.
 */
export function BillingBanner() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/billing/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (alive && body) setStatus(body as Status);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!status?.applicable || status.tone === "ok") return null;

  const stopped = status.tone === "stopped";

  return (
    <div
      role="status"
      className={`mb-6 rounded-lg border p-4 ${
        stopped ? "border-rose-500/40 bg-rose-500/10" : "border-amber-500/40 bg-amber-500/10"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`font-semibold ${stopped ? "text-rose-200" : "text-amber-200"}`}>
            {status.title}
          </p>
          <p className="mt-1 max-w-2xl text-sm text-slate-300">{status.detail}</p>
        </div>
        <Link
          href="/account/billing"
          className={`shrink-0 rounded px-3 py-2 text-sm font-medium text-white transition ${
            stopped ? "bg-rose-500 hover:bg-rose-400" : "bg-amber-500 hover:bg-amber-400"
          }`}
        >
          {stopped ? "Restart MAYA" : "Fix it"}
        </Link>
      </div>
    </div>
  );
}
