import { SignupCodeActions } from "@/components/admin/signup-code-actions";
import { SignupCodeForm } from "@/components/admin/signup-code-form";
import {
  listSignupCodes,
  type AdminSignupCodeRow,
  type SignupCodeStatus,
} from "@/lib/admin/signup-codes";
import { formatUsd } from "@/lib/billing/tiers";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<SignupCodeStatus, string> = {
  live: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  off: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  expired: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  exhausted: "bg-amber-500/10 text-amber-300 border-amber-500/30",
};

const STATUS_LABELS: Record<SignupCodeStatus, string> = {
  live: "live",
  off: "off",
  expired: "expired",
  exhausted: "used up",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function AdminSignupCodesPage() {
  const ssr = createClient(await cookies());
  const codes = await listSignupCodes(ssr);
  const live = codes.filter((c) => c.status === "live").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Signup codes</h1>
        <p className="text-sm text-slate-400">
          {codes.length} code{codes.length === 1 ? "" : "s"}, {live} live. Nobody reaches
          checkout without one, so a code is both the gate and the deal.
        </p>
      </div>

      <SignupCodeForm />

      <div className="space-y-4">
        {codes.map((code) => (
          <CodeCard key={code.id} code={code} />
        ))}
        {codes.length === 0 && (
          <p className="rounded border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
            No codes yet — until there is one, nobody can sign up.
          </p>
        )}
      </div>

      {codes.length > 0 && (
        <p className="text-xs text-slate-600">
          Monthly figures apply MAYA&apos;s own brackets to the rooms each property is billed
          for, less the code&apos;s percentage. Stripe&apos;s invoices are what actually got
          collected.
        </p>
      )}
    </div>
  );
}

function CodeCard({ code }: { code: AdminSignupCodeRow }) {
  const used = code.redemptions.length;

  return (
    <section className="rounded border border-slate-800 bg-slate-900">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg font-semibold text-slate-100">{code.code}</span>
            <span
              className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[code.status]}`}
            >
              {STATUS_LABELS[code.status]}
            </span>
          </div>
          <p className="text-sm text-slate-300">{code.grants}</p>
          <p className="text-xs text-slate-500">{limitsLine(code)}</p>
          {code.notes && <p className="max-w-2xl text-xs italic text-slate-400">{code.notes}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <div className="text-sm text-slate-200">
              used {used} time{used === 1 ? "" : "s"}
            </div>
            <div className="text-xs text-slate-400">{moneyLine(code)}</div>
          </div>
          <SignupCodeActions codeId={code.id} isActive={code.is_active} />
        </div>
      </header>

      {used === 0 ? (
        <p className="p-4 text-sm text-slate-500">Not used yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Account admin</th>
                <th className="px-4 py-2">Hotel</th>
                <th className="px-4 py-2">Redeemed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {code.redemptions.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 font-medium text-slate-100">{r.email}</td>
                  <td className="px-4 py-2 text-slate-300">{r.hotel_name ?? "—"}</td>
                  <td className="px-4 py-2 text-slate-400">{formatDate(r.redeemed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function limitsLine(code: AdminSignupCodeRow): string {
  return [
    code.max_redemptions == null
      ? "no redemption cap"
      : `capped at ${code.max_redemptions} redemption${code.max_redemptions === 1 ? "" : "s"}`,
    code.expires_at ? `expires ${formatDate(code.expires_at)}` : "no expiry",
    `created ${formatDate(code.created_at)}${code.created_by_email ? ` by ${code.created_by_email}` : ""}`,
  ].join(" · ");
}

function moneyLine(code: AdminSignupCodeRow): string {
  const parts: string[] = [];
  if (code.paying > 0) {
    const discounted =
      code.list_mrr_cents > code.mrr_cents ? ` of ${formatUsd(code.list_mrr_cents)} list` : "";
    parts.push(
      `${formatUsd(code.mrr_cents)}/mo${discounted} from ${code.paying} propert${
        code.paying === 1 ? "y" : "ies"
      }`,
    );
  }
  if (code.trialing > 0) parts.push(`${code.trialing} on trial`);
  return parts.length > 0 ? parts.join(" · ") : "no live subscriptions";
}
