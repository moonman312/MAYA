import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ManageBillingButton, RoomCountForm } from "@/components/billing/billing-actions";
import {
  headlineFor,
  loadAccountBilling,
  longDate,
  periodEndLabel,
  type BillingTone,
} from "@/lib/billing/account";
import { hasHotelRank } from "@/lib/require-supabase-hotel";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { formatUsd } from "@/lib/billing/tiers";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

const TONE_STYLES: Record<BillingTone, string> = {
  ok: "border-slate-800 bg-slate-900",
  warn: "border-amber-500/40 bg-amber-500/5",
  stopped: "border-rose-500/40 bg-rose-500/5",
};

/** Stripe's vocabulary, in words an owner would use. */
const STATUS_LABELS: Record<string, string> = {
  trialing: "On trial",
  active: "Active",
  past_due: "Payment overdue",
  unpaid: "Unpaid — stopped",
  canceled: "Cancelled",
  incomplete: "Never completed",
  incomplete_expired: "Never completed",
  paused: "Paused",
};

export default async function BillingPage() {
  const supabase = createClient(await cookies());

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) redirect("/onboarding");

  // Same bar as the routes this page drives, checked here too so someone below
  // it gets an explanation instead of buttons that will 403.
  if (!(await hasHotelRank(supabase, hotelId, "general_manager"))) {
    return (
      <Shell>
        <p className="rounded border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
          Billing is handled by this property&apos;s General Manager or Hotel Admin. Ask one of them
          for access if you need to change it.
        </p>
      </Shell>
    );
  }

  const billing = await loadAccountBilling(supabase, hotelId);
  if (!billing) {
    return (
      <Shell>
        <p className="rounded border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
          This property has no subscription — it was set up by hand rather than through checkout, so
          there is nothing to bill or manage here.
        </p>
      </Shell>
    );
  }

  const headline = headlineFor(billing);

  return (
    <Shell>
      <section className={`rounded border p-4 ${TONE_STYLES[headline.tone]}`}>
        <h2 className="font-semibold text-slate-100">{headline.title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-300">{headline.detail}</p>
        {!billing.entitled && (
          <Link
            href="/onboarding"
            className="mt-3 inline-block rounded bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-400"
          >
            Restart the subscription
          </Link>
        )}
      </section>

      <section className="rounded border border-slate-800 bg-slate-900">
        <h2 className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-slate-200">
          Your plan
        </h2>
        <dl className="divide-y divide-slate-800">
          <Row label="Status" value={STATUS_LABELS[billing.status] ?? billing.status} />
          <Row
            label={billing.entitled ? "Price" : "Was"}
            value={`${formatUsd(billing.periodCents)} per ${billing.interval === "year" ? "year" : "month"}`}
            hint={`${billing.rooms} room${billing.rooms === 1 ? "" : "s"} at MAYA's ${billing.interval === "year" ? "annual" : "monthly"} rate.`}
          />
          {billing.trialEndsAt && billing.entitled && (
            <Row label="Trial ends" value={longDate(billing.trialEndsAt)} />
          )}
          {billing.renewsAt && <Row label={periodEndLabel(billing)} value={longDate(billing.renewsAt)} />}
          {billing.signupCode && <Row label="Signup code" value={billing.signupCode} />}
        </dl>
      </section>

      {billing.cardTrouble && (
        <section className="rounded border border-amber-500/40 bg-amber-500/5 p-4">
          <h2 className="text-sm font-semibold text-amber-200">Your card needs attention</h2>
          <p className="mt-1 text-sm text-amber-100/80">
            We checked it on {longDate(billing.cardTrouble.since)} and your bank declined it
            {billing.cardTrouble.code ? ` (${billing.cardTrouble.code})` : ""}. Nothing has failed
            yet — updating it now avoids an interruption.
          </p>
        </section>
      )}

      <section className="rounded border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-slate-200">Manage</h2>
        <div className="mt-3">
          <ManageBillingButton />
        </div>
      </section>

      {billing.entitled && (
        <section className="rounded border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold text-slate-200">Room count</h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-400">
            MAYA bills for the rooms you sell. Change it whenever the property does — the price moves
            to whichever bracket the new count lands in.
          </p>
          <div className="mt-3">
            <RoomCountForm currentRooms={billing.rooms} interval={billing.interval} />
          </div>
        </section>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-6 py-10 text-slate-200">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">
          ← Back to MAYA
        </Link>
      </div>
      {children}
    </main>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
      <dt className="text-sm text-slate-400">{label}</dt>
      <dd className="text-right">
        <div className="text-sm font-medium text-slate-100">{value}</div>
        {hint && <div className="text-xs text-slate-500">{hint}</div>}
      </dd>
    </div>
  );
}
