import Link from "next/link";
import { cookies } from "next/headers";
import { StalledSignupActions } from "@/components/admin/stalled-signup-actions";
import {
  listStalledSignups,
  rollUp,
  stuckFor,
  summarize,
  type StallSeverity,
  type StallWindow,
  type TriagedSignup,
} from "@/lib/admin/stalled-signups";
import { formatUsd } from "@/lib/billing/tiers";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

const SEVERITY_STYLES: Record<StallSeverity, string> = {
  burning: "border-rose-500/40 bg-rose-500/5",
  dead_card: "border-fuchsia-500/40 bg-fuchsia-500/5",
  warming: "border-amber-500/40 bg-amber-500/5",
  nudge: "border-slate-800 bg-slate-900",
};

const SEVERITY_BADGES: Record<StallSeverity, { label: string; className: string }> = {
  burning: { label: "paying for nothing", className: "bg-rose-500/10 text-rose-300 border-rose-500/30" },
  dead_card: { label: "card failed too", className: "bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/30" },
  warming: { label: "first payment taken", className: "bg-amber-500/10 text-amber-300 border-amber-500/30" },
  nudge: { label: "nothing collected yet", className: "bg-slate-500/10 text-slate-400 border-slate-500/30" },
};

const WINDOWS: { hours: StallWindow; label: string }[] = [
  { hours: 24, label: "over a day" },
  { hours: 72, label: "over 3 days" },
  { hours: 168, label: "over a week" },
];

function parseWindow(raw: string | undefined): StallWindow {
  const n = Number(raw);
  return WINDOWS.some((w) => w.hours === n) ? (n as StallWindow) : 24;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function AdminStalledSignupsPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string; abandoned?: string }>;
}) {
  const sp = await searchParams;
  const minHours = parseWindow(sp.hours);
  const includeAbandoned = sp.abandoned === "1";

  const ssr = createClient(await cookies());

  let rows: TriagedSignup[];
  try {
    rows = await listStalledSignups(ssr, { minHours, includeAbandoned });
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Stalled signups</h1>
        <p className="rounded border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-200">
          {error instanceof Error ? error.message : "Could not read the list."}
        </p>
      </div>
    );
  }
  const totals = rollUp(rows);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Stalled signups</h1>
        <p className="max-w-3xl text-sm text-slate-400">{summarize(totals)}</p>
      </div>

      {totals.count > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="Taken for nothing"
            value={formatUsd(totals.spent_cents)}
            hint="Estimated from the billing period, not Stripe's invoices."
          />
          <Stat
            label="At risk per month"
            value={formatUsd(totals.monthly_cents)}
            hint="What these properties are worth if they get set up."
          />
          <Stat
            label="Charged twice or more"
            value={String(totals.burning)}
            hint="The ones most likely to ask for it back."
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-slate-500">Stuck</span>
          {WINDOWS.map((w) => (
            <Link
              key={w.hours}
              href={`/admin/stalled-signups?hours=${w.hours}${includeAbandoned ? "&abandoned=1" : ""}`}
              className={`rounded px-2 py-1 transition ${
                minHours === w.hours
                  ? "bg-slate-800 text-slate-100"
                  : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              }`}
            >
              {w.label}
            </Link>
          ))}
        </div>
        <Link
          href={`/admin/stalled-signups?hours=${minHours}${includeAbandoned ? "" : "&abandoned=1"}`}
          className="rounded border border-slate-700 px-2 py-1 text-slate-400 hover:border-slate-500 hover:text-slate-200"
        >
          {includeAbandoned ? "Hide the ones you gave up on" : "Show the ones you gave up on"}
        </Link>
      </div>

      <div className="space-y-3">
        {rows.map((row) => (
          <SignupCard key={row.hotel_id} row={row} />
        ))}
        {rows.length === 0 && (
          <p className="rounded border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
            {includeAbandoned
              ? "Nothing stuck this long."
              : "Nothing stuck this long — try a shorter window, or show the ones you gave up on."}
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

function SignupCard({ row }: { row: TriagedSignup }) {
  const badge = SEVERITY_BADGES[row.severity];
  const rooms = `${row.billed_rooms} room${row.billed_rooms === 1 ? "" : "s"}`;
  const mismatch =
    row.rooms_measured != null && row.rooms_measured !== row.billed_rooms
      ? ` (PMS counted ${row.rooms_measured})`
      : "";

  return (
    <section className={`rounded border ${SEVERITY_STYLES[row.severity]} p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-100">{row.headline}</span>
            <span className={`rounded border px-2 py-0.5 text-xs font-medium ${badge.className}`}>
              {badge.label}
            </span>
            <span className="text-xs text-slate-400">stuck {stuckFor(row.stuck_hours)}</span>
            {row.signup_abandoned_at && (
              <span className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-500">
                gave up {formatDate(row.signup_abandoned_at)}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
            <span className="font-medium">{row.admin_email ?? "no account admin on the hotel"}</span>
            {row.admin_email && !row.email_confirmed && (
              <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-300">
                email never confirmed
              </span>
            )}
            {row.admin_name && <span className="text-slate-500">· {row.admin_name}</span>}
          </div>

          <p className="text-xs text-slate-400">
            {[
              row.hotel_name ?? "no property yet",
              rooms + mismatch,
              `${formatUsd(row.monthly_cents)}/mo`,
              row.signup_code ? `code ${row.signup_code}` : "no code",
              row.pms_type ? `${row.pms_type} · ${row.pms_status}` : "no PMS connected",
              `signed up ${formatDate(row.created_at)}`,
              row.last_sign_in_at ? `last seen ${formatDate(row.last_sign_in_at)}` : "never signed in again",
            ].join(" · ")}
          </p>

          <p className="text-xs text-slate-500">
            {row.status === "trialing" && row.trial_end
              ? `Trial ends ${formatDate(row.trial_end)}.`
              : row.severity === "nudge"
                ? "Nothing collected yet."
                : `About ${row.periods_billed} payment${row.periods_billed === 1 ? "" : "s"} taken — ${formatUsd(row.spent_cents)}.`}{" "}
            {row.current_period_end && row.status !== "trialing" && (
              <>Next renews {formatDate(row.current_period_end)}.</>
            )}
          </p>

          {row.card_verify_last_code && (
            <p className="text-xs text-fuchsia-300">Card check said: {row.card_verify_last_code}</p>
          )}
          {row.import_error && (
            <p className="max-w-2xl truncate text-xs text-rose-300" title={row.import_error}>
              Import error: {row.import_error}
            </p>
          )}
          {row.import_status && !row.import_error && (
            <p className="text-xs text-slate-500">
              Import {row.import_status}
              {row.import_phase ? ` at ${row.import_phase}` : ""}.
            </p>
          )}
          {row.signup_abandoned_note && (
            <p className="text-xs italic text-slate-500">{row.signup_abandoned_note}</p>
          )}

          <p className="pt-1 text-xs text-slate-300">{row.action}</p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <StalledSignupActions
            hotelId={row.hotel_id}
            abandonedAt={row.signup_abandoned_at}
            email={row.reachable ? row.admin_email : null}
          />
          {row.hotel_name && (
            <Link
              href={`/admin/hotels/${row.hotel_id}`}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Open the property →
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
