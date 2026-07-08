"use client";

import type { PmsConnectionStatus, PmsType } from "@/lib/admin/types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function HotelPmsCard({
  hotelId,
  pmsType,
  pmsStatus,
}: {
  hotelId: string;
  pmsType: PmsType | null;
  pmsStatus: PmsConnectionStatus | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [env, setEnv] = useState<"demo" | "production">("demo");
  const [clientToken, setClientToken] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [enterpriseId, setEnterpriseId] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function callApi(action: "test" | "save" | "delete") {
    setError(null);
    setTestResult(null);
    const body: Record<string, unknown> = { env, clientToken, accessToken };
    if (enterpriseId) body.enterpriseId = enterpriseId;

    const method =
      action === "test" ? "POST" : action === "delete" ? "DELETE" : "PUT";
    const url =
      action === "test"
        ? `/api/admin/hotels/${hotelId}/pms/mews/test`
        : `/api/admin/hotels/${hotelId}/pms/mews`;

    startTransition(async () => {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: action === "delete" ? undefined : JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload.error ?? `Request failed (${res.status})`);
        return;
      }
      if (action === "test") {
        setTestResult(
          `Connected to ${payload.enterprise?.name ?? "(unknown)"} (${payload.enterprise?.id ?? "?"})`,
        );
      } else {
        setEditing(false);
        setClientToken("");
        setAccessToken("");
        setEnterpriseId("");
        router.refresh();
      }
    });
  }

  return (
    <section className="rounded border border-slate-800 bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          PMS connection
        </h2>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-400">
            {pmsType ? `${pmsType} · ${pmsStatus ?? "no status"}` : "not configured"}
          </span>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-slate-700 px-2 py-1 text-xs hover:border-slate-500"
          >
            {editing ? "Cancel" : pmsType ? "Rotate credentials" : "Connect Mews"}
          </button>
          {pmsType && (
            <button
              type="button"
              onClick={() => callApi("delete")}
              disabled={pending}
              className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:border-rose-400 disabled:opacity-60"
            >
              Disconnect
            </button>
          )}
        </div>
      </header>

      {editing && (
        <div className="space-y-3 p-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-slate-500">Environment</span>
              <select
                value={env}
                onChange={(e) => setEnv(e.target.value as "demo" | "production")}
                className="rounded bg-slate-950 p-2 text-slate-100"
              >
                <option value="demo">demo (api.mews-demo.com)</option>
                <option value="production">production (api.mews.com)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Enterprise ID (optional)
              </span>
              <input
                type="text"
                value={enterpriseId}
                onChange={(e) => setEnterpriseId(e.target.value)}
                className="rounded bg-slate-950 p-2 text-slate-100"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Client token</span>
              <input
                type="password"
                value={clientToken}
                onChange={(e) => setClientToken(e.target.value)}
                className="rounded bg-slate-950 p-2 text-slate-100"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Access token</span>
              <input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                className="rounded bg-slate-950 p-2 text-slate-100"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => callApi("test")}
              disabled={pending || !clientToken || !accessToken}
              className="rounded border border-slate-700 px-3 py-2 text-sm hover:border-slate-500 disabled:opacity-60"
            >
              Test connection
            </button>
            <button
              type="button"
              onClick={() => callApi("save")}
              disabled={pending || !clientToken || !accessToken}
              className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-60"
            >
              Save credentials
            </button>
            {testResult && <span className="text-xs text-emerald-300">{testResult}</span>}
            {error && <span className="text-xs text-rose-300">{error}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
