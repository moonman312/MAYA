import Link from "next/link";
import {
  WALKED_AWAY_STAGES,
  countOf,
  formatDuration,
  type AcquisitionRow,
  type BookRow,
  type CancellationRow,
  type EventCountRow,
  type FunnelRow,
  type GroupRow,
  type HealthRow,
  type RetentionRow,
  type TimeToValueRow,
  type TrialRow,
  type WalkedAwayRow,
  type WalkedAwaySummaryRow,
} from "@/lib/admin/product-analytics";
import type { PushProblemAnalytics } from "@/lib/admin/push-problems";
import { formatUsd } from "@/lib/billing/tiers";
import type { ReactNode } from "react";

/**
 * The product half of /admin/analytics: where Marketplace connections go,
 * how long each step takes, and who to call about the ones that stopped.
 *
 * Bars are one series, so one hue: slot-1 blue, the same validated step the
 * revenue charts use on this surface (analytics-charts.tsx). Every number a
 * bar shows is also printed beside it and in the follow-up list, so nothing
 * depends on reading a length. Everything else is a compact table, because
 * these are lists of counts to compare, not shapes to see.
 */

const BLUE = "#3987e5";

const STAGE_LABEL: Record<string, string> = {
  connected: "Connected",
  claimed: "Claimed",
  started_checkout: "Started checkout",
  subscribed: "Subscribed",
  history_imported: "History imported",
  went_live: "Went live",
  paying: "Paying",
  account_created: "Account created",
  saw_pricing: "Saw pricing",
  pms_connected: "PMS connected",
  checkout_started: "Started checkout",
  trialing: "Trialing",
};

const STEP_LABEL: Record<string, string> = {
  connect_to_claim: "Connect → claim",
  claim_to_subscribe: "Claim → subscribe",
  subscribe_to_pms_connected: "Subscribe → PMS connected (direct)",
  subscribe_to_import_complete: "Subscribe → history imported",
  import_to_live: "Imported → live",
  connect_to_live: "Connect → live (Marketplace)",
  subscribe_to_live: "Subscribe → live",
};

function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

function pct(n: number | string | null | undefined): string {
  return n == null || n === "" || !Number.isFinite(Number(n)) ? "—" : `${Math.round(Number(n))}%`;
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Bar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix?: string }) {
  return (
    <div className="flex items-center gap-3 text-xs" title={`${label}: ${value}${suffix ? ` (${suffix})` : ""}`}>
      <span className="w-56 shrink-0 text-slate-400">{label}</span>
      <div className="h-4 flex-1">
        {value > 0 && (
          <div
            className="h-4 rounded-r-[4px]"
            style={{ width: `${Math.max(1.5, (value / Math.max(1, max)) * 100)}%`, background: BLUE }}
          />
        )}
      </div>
      <span className="w-10 text-right font-semibold tabular-nums text-slate-100">{value}</span>
      <span className="w-20 shrink-0 whitespace-nowrap text-right tabular-nums text-slate-500">{suffix ?? ""}</span>
    </div>
  );
}

/** Words read left-aligned and counts right-aligned; by default only the first column is words. */
function Table({
  head,
  rows,
  empty,
  textColumns = 1,
}: {
  head: string[];
  rows: ReactNode[][];
  empty: string;
  textColumns?: number;
}) {
  if (rows.length === 0) return <p className="text-xs text-slate-500">{empty}</p>;
  const numeric = (i: number) => i >= textColumns;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            {head.map((h, i) => (
              <th key={h} className={`whitespace-nowrap pb-1.5 pr-3 font-normal last:pr-0 ${numeric(i) ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={`py-1.5 pr-3 last:pr-0 ${numeric(j) ? "whitespace-nowrap text-right tabular-nums text-slate-200" : "text-slate-300"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WalkedAwayCard({
  summary,
  rows,
  from,
  to,
}: {
  summary: WalkedAwaySummaryRow[];
  rows: WalkedAwayRow[];
  from: string;
  to: string;
}) {
  const n = (stage: string) => summary.find((s) => s.stage === stage);
  const connected = n("connected")?.properties ?? 0;
  const walked = n("walked_away")?.properties ?? 0;
  const max = Math.max(1, ...WALKED_AWAY_STAGES.map((s) => n(s.stage)?.properties ?? 0));
  const followUp = rows.filter((r) => r.outcome === "walked_away");

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Connected and walked away</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Properties whose first Cloudbeds Marketplace connect was {from} to {to}, as they stand now
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-slate-100">
            {walked} <span className="text-sm font-normal text-slate-400">of {connected}</span>
          </div>
          <div className="text-[11px] text-slate-500">
            {n("converted")?.properties ?? 0} paying · {n("in_flight")?.properties ?? 0} still in flight
          </div>
        </div>
      </div>

      <div className="space-y-2 px-4 py-3">
        {WALKED_AWAY_STAGES.map((s) => {
          const row = n(s.stage);
          const deferred = row?.deferred ?? 0;
          return (
            <Bar
              key={s.stage}
              label={s.label}
              value={row?.properties ?? 0}
              max={max}
              suffix={deferred > 0 ? `${deferred} not now` : undefined}
            />
          );
        })}
      </div>

      <div className="border-t border-slate-800 px-4 py-3">
        <h3 className="mb-2 text-xs font-medium text-slate-400">Follow up ({followUp.length})</h3>
        <Table
          empty="Nobody walked away from this period."
          textColumns={7}
          head={["Property", "PMS", "Connected", "Got as far as", "Stopped at", "Owner", "Last activity"]}
          rows={followUp.map((r) => [
            r.hotel_id && r.hotel_exists ? (
              <Link key="p" href={`/admin/hotels/${r.hotel_id}`} className="text-slate-200 hover:text-sky-300">
                {r.property_name ?? r.property_key}
              </Link>
            ) : (
              <span key="p" title="The parked property has been swept">
                {r.property_name ?? r.property_key}
              </span>
            ),
            [r.pms_type ?? "—", r.group_size ? ` · group of ${r.group_size}` : ""].join(""),
            <span key="c" className="whitespace-nowrap">{day(r.connected_at)}</span>,
            STAGE_LABEL[r.furthest_stage] ?? r.furthest_stage,
            [
              WALKED_AWAY_STAGES.find((s) => s.stage === r.walked_away_stage)?.label ?? "—",
              r.deferred ? " (not now)" : "",
            ].join(""),
            r.owner_email ?? "no account",
            <span key="l" className="whitespace-nowrap">{day(r.last_activity_at)}</span>,
          ])}
        />
      </div>
    </section>
  );
}

export function ProductFunnels({ funnel }: { funnel: FunnelRow[] }) {
  const paths: { path: FunnelRow["path"]; title: string; hint: string }[] = [
    { path: "marketplace", title: "Marketplace funnel", hint: "properties first connected in range, followed to now" },
    { path: "direct", title: "Direct signup funnel", hint: "accounts created in range, followed to now" },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {paths.map(({ path, title, hint }) => {
        const steps = funnel.filter((f) => f.path === path).sort((a, b) => a.step - b.step);
        const max = Math.max(1, ...steps.map((s) => s.entered));
        return (
          <Panel key={path} title={title} hint={hint}>
            <div className="space-y-2">
              {steps.map((s) => (
                <Bar
                  key={s.stage}
                  label={STAGE_LABEL[s.stage] ?? s.stage}
                  value={s.entered}
                  max={max}
                  suffix={s.step === 1 ? undefined : pct(s.pct_of_previous)}
                />
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Percent is of the stage before.</p>
          </Panel>
        );
      })}
    </div>
  );
}

export function BookTiles({ book }: { book: BookRow | null }) {
  if (!book) return null;
  const tiles = [
    { label: "Active properties", value: String(book.active_properties), hint: `${book.live} live · ${book.simulating} simulating` },
    {
      label: "Rooms under management",
      value: book.billed_rooms_paying.toLocaleString("en-US"),
      hint: `billed, paying · ${book.measured_rooms_active.toLocaleString("en-US")} measured across active`,
    },
    {
      label: "MRR (snapshot)",
      value: book.net_mrr_cents == null ? "—" : formatUsd(book.net_mrr_cents),
      hint: book.mrr_snapshot_day
        ? `net · ${formatUsd(book.list_mrr_cents ?? 0)} list · ${day(book.mrr_snapshot_day)}`
        : "no snapshot yet",
    },
    {
      label: "Waiting on an owner",
      value: String(book.awaiting_claim + book.deferred),
      hint: `${book.awaiting_claim} unclaimed · ${book.deferred} not now · ${book.expired_awaiting_sweep} expired`,
    },
  ];
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <div className="text-xs text-slate-400">{t.label}</div>
          <div className="mt-1 text-2xl font-semibold text-slate-100">{t.value}</div>
          <div className="mt-1 text-[11px] text-slate-500">{t.hint}</div>
        </div>
      ))}
    </section>
  );
}

export function TimeToValuePanel({ rows }: { rows: TimeToValueRow[] }) {
  return (
    <Panel title="Time to value" hint="medians, by when the later step happened">
      <Table
        empty="Nothing finished a step in this range."
        head={["Step", "Properties", "Median", "75th pct"]}
        rows={rows.map((r) => [STEP_LABEL[r.step] ?? r.step, r.properties, formatDuration(r.median_hours), formatDuration(r.p75_hours)])}
      />
    </Panel>
  );
}

export function TrialsPanel({ rows }: { rows: TrialRow[] }) {
  return (
    <Panel title="Trial conversion" hint="trials that ended in range">
      <Table
        empty="No trials ended in this range."
        head={["", "Ended", "Paid", "Lost", "Open", "Rate"]}
        rows={rows.map((r) => [r.segment, r.trials_ended, r.converted, r.lost, r.undecided, pct(r.conversion_pct)])}
      />
    </Panel>
  );
}

export function RetentionPanel({ row }: { row: RetentionRow | null }) {
  if (!row) return null;
  return (
    <Panel title="Retention" hint="paying = a Stripe plan, active or past due">
      <Table
        empty=""
        head={["", "Properties"]}
        rows={[
          ["Paying at start", row.paying_at_start],
          ["New paying", row.new_paying],
          ["Won back", row.won_back],
          ["Churned", `${row.churned} · ${row.rooms_churned} rooms`],
          ["Churn of starting base", pct(row.churn_pct)],
          ["Paying at end", row.paying_at_end],
          ["Cancellation scheduled / withdrawn", `${row.cancel_scheduled} / ${row.cancel_withdrawn}`],
          ["Disconnected / reconnected / still out", `${row.disconnected} / ${row.reconnected} / ${row.still_disconnected}`],
        ]}
      />
    </Panel>
  );
}

export function CancellationsPanel({ rows }: { rows: CancellationRow[] }) {
  return (
    <Panel title="Why they cancel" hint="Stripe's reason and the portal answer">
      <Table
        empty="No cancellations in this range."
        textColumns={2}
        head={["Reason", "Kind", "Properties", "Rooms"]}
        rows={rows.map((r) => [
          `${r.feedback === "not_given" ? r.reason.replaceAll("_", " ") : r.feedback.replaceAll("_", " ")}`,
          `${r.kind.replaceAll("_", " ")}${r.was_paying ? "" : " (trial)"}`,
          r.properties,
          r.billed_rooms,
        ])}
      />
    </Panel>
  );
}

export function AcquisitionPanel({ rows }: { rows: AcquisitionRow[] }) {
  return (
    <Panel title="Subscriptions by source" hint="started in range, status now">
      <Table
        empty="No subscriptions started in this range."
        head={["Source", "Started", "Trialing", "Paying", "Lost", "Rooms"]}
        rows={rows.map((r) => [
          `${r.channel} · ${r.code}`,
          r.subscriptions,
          r.trialing_now,
          r.paying_now,
          r.lost_now,
          r.billed_rooms,
        ])}
      />
    </Panel>
  );
}

export function HealthPanel({ rows }: { rows: HealthRow[] }) {
  const label = (m: string) =>
    m.startsWith("sync.requests_last_")
      ? `PMS requests failing (last ${m.slice("sync.requests_last_".length)})`
      : m.replace("import.failed:", "  failed: ").replace(".", " ");
  return (
    <Panel title="Imports and PMS health">
      <Table
        empty="Nothing happened in this range."
        head={["", "Count", "Properties", "Rate", "Median"]}
        rows={rows.map((r) => [
          label(r.metric),
          r.occurrences,
          r.properties,
          r.rate_pct == null ? "—" : `${Number(r.rate_pct)}%`,
          r.median_minutes == null
            ? "—"
            : `${formatDuration(Number(r.median_minutes) / 60)}${r.median_rows == null ? "" : ` · ${Math.round(Number(r.median_rows)).toLocaleString("en-US")} rows`}`,
        ])}
      />
    </Panel>
  );
}

export function EngagementPanel({ events }: { events: EventCountRow[] }) {
  const line = (label: string, event: string, detail?: string, unit?: string) => {
    const c = countOf(events, event, detail);
    return [label, c.occurrences, c.properties, unit ? `${c.quantity} ${unit}` : ""];
  };
  const joined = countOf(events, "team.member_joined");
  const owners = countOf(events, "team.member_joined", "first_member");
  return (
    <Panel title="Engagement" hint="what owners did with the product in range">
      <Table
        empty=""
        head={["", "Times", "Properties", ""]}
        rows={[
          line("Rules made by an owner", "rule.created", "owner"),
          line("Rules accepted from a suggestion", "rule.created", "suggestion"),
          line("Starter rules created", "rule.created", "starter"),
          line("Rules switched off", "rule.disabled"),
          line("Rules edited", "rule.edited"),
          line("Rules deleted", "rule.deleted"),
          line("Manual prices set", "manual_price.set", undefined, "nights"),
          line("Manual prices cleared", "manual_price.cleared", undefined, "nights"),
          line("Change log opened", "dashboard.tab_opened", "changelog"),
          line("Simulator opened", "dashboard.tab_opened", "simulator"),
          line("Simulator used", "simulator.used"),
          line('"How did we know?" opened', "explain.opened"),
          line("Went live", "property.went_live"),
          line("Back to simulation", "property.back_to_simulation"),
          line("Room types classified", "room_type.classified"),
          line("Units taken out of service", "room_type.out_of_service_added", undefined, "units"),
          line("Teammates invited", "team.invited"),
          ["Teammates joined (not the first owner)", joined.occurrences - owners.occurrences, "—", ""],
          line("Teammates removed", "team.member_removed"),
          line("Billing portal opened", "billing.portal_opened"),
          line('"Not now" on a group property', "marketplace.deferred"),
          line("Picked back up", "marketplace.resumed"),
        ]}
      />
    </Panel>
  );
}

export function GroupsPanel({ rows }: { rows: GroupRow[] }) {
  return (
    <Panel title="Group connections" hint="first connected in range">
      <Table
        empty="No groups connected in this range."
        head={["Group", "Size", "Connected", "Claimed", "Subscribed", "Not now", "Expired"]}
        rows={rows.map((r) => [
          r.first_property_name ?? r.group_key,
          r.group_size ?? r.properties_connected,
          r.properties_connected,
          r.claimed,
          r.subscribed,
          r.deferred_now,
          r.expired_unclaimed,
        ])}
      />
    </Panel>
  );
}

function RootCause({ known, guardrail, mayaBug }: { known: boolean; guardrail?: boolean; mayaBug?: boolean }) {
  return (
    <span className="whitespace-nowrap">
      <span className={known ? "text-emerald-300" : "text-amber-300"}>{known ? "Known" : "Unknown"}</span>
      {guardrail ? <span className="text-slate-500"> · guardrail</span> : null}
      {mayaBug ? <span className="text-rose-300"> · MAYA bug</span> : null}
    </span>
  );
}

const causeLabel = (cause: string) => cause.replaceAll("_", " ");

/**
 * Why rates did not reach a PMS, per cause, for incidents opened in the
 * range. "By retry" closed with every cell landing before an owner was shown
 * anything; "Shown" reached the owner's change log. Unknown causes list what
 * the PMS actually said, which is what teaches push-failure.ts a new cause.
 */
export function PushProblemsPanel({ data }: { data: PushProblemAnalytics }) {
  if (!data.available) {
    return (
      <Panel title="Rate push problems">
        <p className="text-xs text-slate-400">{data.reason}</p>
      </Panel>
    );
  }
  const samples = data.causes.filter((c) => c.sampleMessages.length > 0);
  return (
    <Panel title="Rate push problems" hint="incidents opened in range; open list is right now">
      <Table
        empty="No rate push problems in this range."
        textColumns={2}
        head={["Cause", "Root cause", "Incidents", "Tries", "Hotels", "By retry", "Shown", "Open", "Median to land"]}
        rows={data.causes.map((c) => [
          <span key="cause" title={c.description}>
            {causeLabel(c.cause)}
          </span>,
          <RootCause key="known" known={c.known} guardrail={c.guardrail} mayaBug={c.mayaBug} />,
          c.incidents,
          c.attempts,
          c.hotels,
          c.resolvedByRetry,
          c.escalated,
          c.open,
          formatDuration(c.medianHoursToLand),
        ])}
      />
      {samples.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="text-xs font-medium text-amber-300">What the PMS said when the cause was unknown</h4>
          {samples.map((c) => (
            <ul key={c.cause} className="space-y-1">
              {c.sampleMessages.map((m) => (
                <li key={m} className="break-words font-mono text-[11px] text-slate-400">
                  {m}
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}
      <div className="mt-4">
        <h4 className="mb-1.5 text-xs font-medium text-slate-300">Open now ({data.open.length})</h4>
        <Table
          empty="Nothing open."
          textColumns={3}
          head={["Hotel", "Cause", "Root cause", "Since", "Tries", "Owner sees it"]}
          rows={data.open.map((o) => [
            <Link key="hotel" href={`/admin/hotels/${o.hotelId}`} className="text-slate-200 hover:text-sky-300">
              {o.hotelName}
            </Link>,
            `${o.pms} · ${causeLabel(o.cause)}`,
            <RootCause key="known" known={o.known} />,
            day(o.openedAt),
            o.attempts,
            o.shownToOwner ? "yes" : "no",
          ])}
        />
      </div>
    </Panel>
  );
}
