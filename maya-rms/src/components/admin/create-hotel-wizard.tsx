"use client";

import type { HotelRole } from "@/lib/admin/types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Step = 1 | 2 | 3;

type HotelStep = {
  name: string;
  timezone: string;
  currency: string;
  total_rooms_per_type: number;
};

type WizardPmsType = "mews" | "cloudbeds" | "think" | "none";

type PmsStep = {
  pmsType: WizardPmsType;
  connect: boolean;
  env: "demo" | "production";
  clientToken: string;
  accessToken: string;
  enterpriseId: string;
  testPassed: boolean;
};

type InviteStep = {
  email: string;
  role: HotelRole;
};

export function CreateHotelWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const [hotel, setHotel] = useState<HotelStep>({
    name: "",
    timezone: "America/Chicago",
    currency: "USD",
    total_rooms_per_type: 50,
  });
  const [pms, setPms] = useState<PmsStep>({
    pmsType: "mews",
    connect: true,
    env: "demo",
    clientToken: "",
    accessToken: "",
    enterpriseId: "",
    testPassed: false,
  });
  const [invite, setInvite] = useState<InviteStep>({
    email: "",
    role: "hotel_admin",
  });

  async function testPms() {
    setError(null);
    setTestResult(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/pms/mews/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          env: pms.env,
          clientToken: pms.clientToken,
          accessToken: pms.accessToken,
          enterpriseId: pms.enterpriseId || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Test failed");
        setPms((p) => ({ ...p, testPassed: false }));
        return;
      }
      setTestResult(
        `Connected to ${body.enterprise?.name ?? "(unknown)"} (${body.enterprise?.id ?? "?"})`,
      );
      setPms((p) => ({ ...p, testPassed: true }));
    });
  }

  async function submit() {
    setError(null);
    startTransition(async () => {
      const payload: Record<string, unknown> = {
        hotel: {
          name: hotel.name.trim(),
          timezone: hotel.timezone,
          currency: hotel.currency,
          total_rooms_per_type: hotel.total_rooms_per_type,
          // The hotel's unique enterprise id only applies to Mews; other PMSes
          // (and "skip for now") leave it null. Pricing settings are omitted on
          // purpose — the server defaults new hotels into simulation mode
          // (see lib/admin/hotels.ts: simulation_mode ?? true). Toggle it off
          // later from the hotel detail page.
          external_enterprise_id:
            pms.pmsType === "mews" ? pms.enterpriseId.trim() || null : null,
        },
      };
      // Only Mews supports token-entry from the wizard. OAuth PMSes (Cloudbeds,
      // Think) are connected after hotel creation from the hotel detail page.
      if (pms.pmsType === "mews" && pms.connect && pms.clientToken && pms.accessToken) {
        payload.pms = {
          env: pms.env,
          clientToken: pms.clientToken,
          accessToken: pms.accessToken,
          enterpriseId: pms.enterpriseId || undefined,
          testFirst: pms.testPassed,
        };
      }
      if (invite.email.trim()) {
        payload.invite = { email: invite.email.trim(), role: invite.role };
      }

      const res = await fetch("/api/admin/hotels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Failed to create hotel");
        return;
      }
      router.push(`/admin/hotels/${body.hotelId}`);
    });
  }

  const canNext1 = hotel.name.trim().length > 0 && hotel.timezone && hotel.currency;
  const canNextPms =
    pms.pmsType !== "mews" ||
    !pms.connect ||
    (pms.clientToken.length > 0 && pms.accessToken.length > 0);
  const canSubmit =
    canNext1 && canNextPms && (invite.email.trim().length === 0 || /.+@.+\..+/.test(invite.email));

  return (
    <div className="space-y-6">
      <StepIndicator step={step} />

      {step === 1 && (
        <Card title="1. Hotel basics">
          <Field label="Name">
            <input
              type="text"
              value={hotel.name}
              onChange={(e) => setHotel({ ...hotel, name: e.target.value })}
              className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
              placeholder="Sunset Bay Resort"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Timezone (IANA)">
              <input
                type="text"
                value={hotel.timezone}
                onChange={(e) => setHotel({ ...hotel, timezone: e.target.value })}
                className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                placeholder="America/Chicago"
              />
            </Field>
            <Field label="Currency (ISO 4217)">
              <input
                type="text"
                value={hotel.currency}
                onChange={(e) =>
                  setHotel({ ...hotel, currency: e.target.value.toUpperCase() })
                }
                className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                placeholder="USD"
              />
            </Field>
            <Field label="Rooms per type (fallback inventory)">
              <input
                type="number"
                min={1}
                value={hotel.total_rooms_per_type}
                onChange={(e) =>
                  setHotel({
                    ...hotel,
                    total_rooms_per_type: Math.max(1, parseInt(e.target.value || "1", 10)),
                  })
                }
                className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
              />
            </Field>
          </div>
          <p className="text-xs text-slate-500">
            New hotels start in <strong className="text-slate-300">simulation mode</strong>. You
            can switch to live pricing anytime from the hotel detail page.
          </p>
          <Actions>
            <button
              type="button"
              disabled={!canNext1}
              onClick={() => setStep(2)}
              className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-60"
            >
              Next
            </button>
          </Actions>
        </Card>
      )}

      {step === 2 && (
        <Card title="2. PMS connection">
          <Field label="PMS">
            <div className="grid gap-2 sm:grid-cols-4">
              {(
                [
                  { v: "mews", label: "Mews", note: "static tokens" },
                  { v: "cloudbeds", label: "Cloudbeds", note: "OAuth" },
                  { v: "think", label: "Think", note: "OAuth" },
                  { v: "none", label: "Skip for now", note: "connect later" },
                ] as const
              ).map((opt) => {
                const selected = pms.pmsType === opt.v;
                return (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() =>
                      setPms({ ...pms, pmsType: opt.v as WizardPmsType, testPassed: false })
                    }
                    className={`rounded border p-3 text-left transition ${
                      selected
                        ? "border-sky-500 bg-sky-500/10"
                        : "border-slate-800 hover:border-slate-600"
                    }`}
                  >
                    <div className="text-sm font-medium text-slate-100">{opt.label}</div>
                    <div className="text-xs text-slate-400">{opt.note}</div>
                  </button>
                );
              })}
            </div>
          </Field>

          {(pms.pmsType === "cloudbeds" || pms.pmsType === "think") && (
            <div className="rounded border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-300">
              <p className="mb-1">
                <strong className="text-slate-100">Connect via OAuth after saving the hotel.</strong>
              </p>
              <p className="text-slate-400">
                Once the hotel exists we redirect to {pms.pmsType === "cloudbeds" ? "Cloudbeds" : "Think Reservations"} for the customer to
                authorize. Tokens get stored in Vault on our callback. Set{" "}
                <code>
                  {pms.pmsType === "cloudbeds" ? "CLOUDBEDS_CLIENT_ID / _SECRET" : "THINK_CLIENT_ID / _SECRET"}
                </code>{" "}
                and <code>PMS_OAUTH_STATE_SECRET</code> in the server env first.
              </p>
            </div>
          )}

          {pms.pmsType === "none" && (
            <div className="rounded border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-400">
              You can connect a PMS anytime from the hotel detail page.
            </div>
          )}

          {pms.pmsType === "mews" && (
            <>
              <Field label="Mews enterprise ID (optional)">
                <input
                  type="text"
                  value={pms.enterpriseId}
                  onChange={(e) => setPms({ ...pms, enterpriseId: e.target.value, testPassed: false })}
                  className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                  placeholder="Mews enterprise GUID (also used as the hotel's unique key)"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={pms.connect}
                  onChange={(e) => setPms({ ...pms, connect: e.target.checked })}
                />
                Configure Mews credentials now
              </label>
            </>
          )}
          {pms.pmsType === "mews" && pms.connect && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Environment">
                  <select
                    value={pms.env}
                    onChange={(e) => setPms({ ...pms, env: e.target.value as "demo" | "production", testPassed: false })}
                    className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                  >
                    <option value="demo">demo (api.mews-demo.com)</option>
                    <option value="production">production (api.mews.com)</option>
                  </select>
                </Field>
                <Field label="Client token">
                  <input
                    type="password"
                    value={pms.clientToken}
                    onChange={(e) => setPms({ ...pms, clientToken: e.target.value, testPassed: false })}
                    className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                  />
                </Field>
                <Field label="Access token">
                  <input
                    type="password"
                    value={pms.accessToken}
                    onChange={(e) => setPms({ ...pms, accessToken: e.target.value, testPassed: false })}
                    className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={testPms}
                  disabled={pending || !pms.clientToken || !pms.accessToken}
                  className="rounded border border-slate-700 px-3 py-2 text-sm hover:border-slate-500 disabled:opacity-60"
                >
                  Test connection
                </button>
                {testResult && (
                  <span className="text-xs text-emerald-300">{testResult}</span>
                )}
                {!testResult && pms.testPassed === false && pms.clientToken && (
                  <span className="text-xs text-slate-500">
                    Not tested yet — you can still save without testing.
                  </span>
                )}
                {error && <span className="text-xs text-rose-300">{error}</span>}
              </div>
            </>
          )}
          <Actions>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded border border-slate-700 px-3 py-2 text-sm hover:border-slate-500"
            >
              Back
            </button>
            <button
              type="button"
              disabled={!canNextPms}
              onClick={() => setStep(3)}
              className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-60"
            >
              Next
            </button>
          </Actions>
        </Card>
      )}

      {step === 3 && (
        <Card title="3. First hotel-admin user">
          <Field label="Email">
            <input
              type="email"
              value={invite.email}
              onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
              placeholder="owner@customer.com"
            />
          </Field>
          <Field label="Role">
            <select
              value={invite.role}
              onChange={(e) => setInvite({ ...invite, role: e.target.value as HotelRole })}
              className="w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
            >
              <option value="hotel_admin">hotel admin</option>
              <option value="manager">manager</option>
              <option value="staff">staff</option>
              <option value="viewer">viewer</option>
            </select>
          </Field>
          <p className="text-xs text-slate-500">
            An invite email will be sent via Supabase Auth. The customer sets a password on
            arrival at <code>/auth/accept-invite</code>. Leave empty to skip.
          </p>
          {error && <p className="text-xs text-rose-300">{error}</p>}
          <Actions>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded border border-slate-700 px-3 py-2 text-sm hover:border-slate-500"
            >
              Back
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || !canSubmit}
              className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-60"
            >
              {pending ? "Creating…" : "Create hotel"}
            </button>
          </Actions>
        </Card>
      )}
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const labels = ["Basics", "PMS", "Invite"];
  return (
    <ol className="flex items-center gap-3 text-xs">
      {labels.map((label, i) => {
        const n = (i + 1) as Step;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${
                active
                  ? "border-sky-500 bg-sky-500 text-white"
                  : done
                  ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                  : "border-slate-700 text-slate-500"
              }`}
            >
              {n}
            </span>
            <span
              className={
                active ? "text-slate-100" : done ? "text-slate-400" : "text-slate-500"
              }
            >
              {label}
            </span>
            {i < labels.length - 1 && <span className="text-slate-700">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded border border-slate-800 bg-slate-900 p-6">
      <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      <span className="uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-2 pt-2">{children}</div>;
}
