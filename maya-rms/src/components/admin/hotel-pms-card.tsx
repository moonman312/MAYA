"use client";

import type { PmsConnectionStatus, PmsType } from "@/lib/admin/types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type PmsStatusItem = {
  type: string;
  displayName: string;
  authKind: "static_tokens" | "oauth2_authorization_code";
  configured: boolean;
  missingEnvVars: string[];
  callbackUrl: string | null;
};

export function HotelPmsCard({
  hotelId,
  pmsType,
  pmsStatus,
  pmsStatuses,
}: {
  hotelId: string;
  pmsType: PmsType | null;
  pmsStatus: PmsConnectionStatus | null;
  pmsStatuses: PmsStatusItem[];
}) {
  const router = useRouter();
  const [chooserChoice, setChooserChoice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [env, setEnv] = useState<"demo" | "production">("demo");
  const [clientToken, setClientToken] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [enterpriseId, setEnterpriseId] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const connected = Boolean(pmsType);
  const activeChoice = pmsType ?? chooserChoice;

  async function callMewsApi(action: "test" | "save" | "delete") {
    setError(null);
    setTestResult(null);
    const body: Record<string, unknown> = { env, clientToken, accessToken };
    if (enterpriseId) body.enterpriseId = enterpriseId;

    const method = action === "test" ? "POST" : action === "delete" ? "DELETE" : "PUT";
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
        setChooserChoice(null);
        setClientToken("");
        setAccessToken("");
        setEnterpriseId("");
        router.refresh();
      }
    });
  }

  return (
    <section className="rounded border border-slate-800 bg-slate-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          PMS connection
        </h2>
        <div className="flex items-center gap-2 text-sm">
          {connected ? (
            <>
              <span className="text-slate-300">
                {pmsType} · <span className="text-slate-400">{pmsStatus ?? "no status"}</span>
              </span>
              {pmsType === "mews" && (
                <button
                  type="button"
                  onClick={() => setEditing((v) => !v)}
                  className="rounded border border-slate-700 px-2 py-1 text-xs hover:border-slate-500"
                >
                  {editing ? "Cancel" : "Rotate credentials"}
                </button>
              )}
              {(pmsType === "cloudbeds" || pmsType === "think") && (
                <a
                  href={`/api/pms/${pmsType}/connect?hotelId=${hotelId}`}
                  className="rounded border border-slate-700 px-2 py-1 text-xs hover:border-slate-500"
                >
                  Re-authorize
                </a>
              )}
              <button
                type="button"
                onClick={() => callMewsApi("delete")}
                disabled={pending || pmsType !== "mews"}
                title={pmsType !== "mews" ? "Disconnect only supported for Mews right now" : ""}
                className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:border-rose-400 disabled:opacity-60"
              >
                Disconnect
              </button>
            </>
          ) : (
            <span className="text-slate-500">not connected</span>
          )}
        </div>
      </header>

      {!connected && (
        <div className="space-y-3 p-4 text-sm">
          <p className="text-slate-400">Choose a PMS to connect for this hotel:</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {pmsStatuses.map((s) => {
              const selected = activeChoice === s.type;
              return (
                <button
                  key={s.type}
                  type="button"
                  onClick={() => {
                    setChooserChoice(s.type);
                    setEditing(s.type === "mews");
                  }}
                  className={`rounded border p-3 text-left transition ${
                    selected
                      ? "border-sky-500 bg-sky-500/10"
                      : "border-slate-800 hover:border-slate-600"
                  }`}
                >
                  <div className="font-medium text-slate-100">{s.displayName}</div>
                  <div className="text-xs text-slate-400">
                    {s.authKind === "oauth2_authorization_code" ? "OAuth" : "Static tokens"}
                  </div>
                  <div className="mt-2 text-xs">
                    {s.configured ? (
                      <span className="text-emerald-300">Ready to connect</span>
                    ) : (
                      <span className="text-amber-300">
                        Missing env: {s.missingEnvVars.join(", ") || "server config"}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {activeChoice === "cloudbeds" && (
            <OAuthConnectPanel hotelId={hotelId} pms={pmsStatuses.find((p) => p.type === "cloudbeds")!} />
          )}
          {activeChoice === "think" && (
            <OAuthConnectPanel hotelId={hotelId} pms={pmsStatuses.find((p) => p.type === "think")!} />
          )}
        </div>
      )}

      {(activeChoice === "mews" || (connected && pmsType === "mews")) && editing && (
        <MewsCredentialsForm
          env={env}
          setEnv={setEnv}
          clientToken={clientToken}
          setClientToken={setClientToken}
          accessToken={accessToken}
          setAccessToken={setAccessToken}
          enterpriseId={enterpriseId}
          setEnterpriseId={setEnterpriseId}
          testResult={testResult}
          error={error}
          pending={pending}
          onTest={() => callMewsApi("test")}
          onSave={() => callMewsApi("save")}
        />
      )}
    </section>
  );
}

function OAuthConnectPanel({
  hotelId,
  pms,
}: {
  hotelId: string;
  pms: PmsStatusItem;
}) {
  return (
    <div className="space-y-3 rounded border border-slate-800 bg-slate-950/60 p-4 text-sm">
      <p className="text-slate-300">
        Connecting via {pms.displayName} redirects to their login. When the customer signs in and
        authorizes, we receive tokens on our callback URL and store them in Supabase Vault.
      </p>
      <dl className="grid gap-1 text-xs text-slate-400">
        <div>
          <dt className="inline text-slate-500">Callback URL: </dt>
          <dd className="inline"><code>{pms.callbackUrl ?? "MAYA_INVITE_REDIRECT_BASE not set"}</code></dd>
        </div>
      </dl>
      {pms.configured ? (
        <a
          href={`/api/pms/${pms.type}/connect?hotelId=${hotelId}`}
          className="inline-block rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400"
        >
          Connect {pms.displayName}
        </a>
      ) : (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          Not configured on this deployment. Set{" "}
          <code>{pms.missingEnvVars.join(", ")}</code> in the server environment and redeploy to
          enable this integration. See{" "}
          <code>MAYA/docs/pms-integrations-status.md</code> for details.
        </div>
      )}
    </div>
  );
}

function MewsCredentialsForm({
  env,
  setEnv,
  clientToken,
  setClientToken,
  accessToken,
  setAccessToken,
  enterpriseId,
  setEnterpriseId,
  testResult,
  error,
  pending,
  onTest,
  onSave,
}: {
  env: "demo" | "production";
  setEnv: (v: "demo" | "production") => void;
  clientToken: string;
  setClientToken: (v: string) => void;
  accessToken: string;
  setAccessToken: (v: string) => void;
  enterpriseId: string;
  setEnterpriseId: (v: string) => void;
  testResult: string | null;
  error: string | null;
  pending: boolean;
  onTest: () => void;
  onSave: () => void;
}) {
  return (
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
          onClick={onTest}
          disabled={pending || !clientToken || !accessToken}
          className="rounded border border-slate-700 px-3 py-2 text-sm hover:border-slate-500 disabled:opacity-60"
        >
          Test connection
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={pending || !clientToken || !accessToken}
          className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-60"
        >
          Save credentials
        </button>
        {testResult && <span className="text-xs text-emerald-300">{testResult}</span>}
        {error && <span className="text-xs text-rose-300">{error}</span>}
      </div>
    </div>
  );
}
