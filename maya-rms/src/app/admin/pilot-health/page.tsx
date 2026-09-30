import { PmsStatusPill } from "@/components/admin/status-pill";
import { describeAlertChannel, loadAlertChannel, type AlertChannelLine } from "@/lib/admin/alert-channel";
import { loadPilotHealth } from "@/lib/admin/pilot-health";
import {
  ageLabel,
  assessProperty,
  compareAssessed,
  humaniseCause,
  type PilotHealthRow,
  type PropertyAssessment,
  type PropertyProblem,
} from "@/lib/admin/pilot-health-assess";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { causeFacts } from "../../../../supabase/functions/_shared/pms/push-failure";

export const dynamic = "force-dynamic";

const PROBLEM_STYLES: Record<PropertyProblem["severity"], string> = {
  amber: "text-amber-300",
  rose: "text-rose-300",
};

const ALERT_LINE_STYLES: Record<AlertChannelLine["severity"], string> = {
  emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  rose: "border-rose-500/30 bg-rose-500/10 text-rose-200",
};

/**
 * Whether the scheduled syncs' alerts have anywhere to go, from what those
 * functions reported (lib/admin/alert-channel.ts), never from the app's own
 * settings. A failed read says so in the same place rather than failing the page.
 */
async function alertChannelLine(ssr: Parameters<typeof loadAlertChannel>[0], nowIso: string): Promise<AlertChannelLine> {
  try {
    return describeAlertChannel(await loadAlertChannel(ssr), nowIso);
  } catch (e) {
    return {
      verdict: "unknown",
      severity: "amber",
      text: `Alerts: not known. The scheduled syncs' reports could not be read: ${e instanceof Error ? e.message : String(e)}`,
      test: null,
    };
  }
}

function ModePill({ mode }: { mode: PilotHealthRow["mode"] }) {
  return mode === "live" ? (
    <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">Live</span>
  ) : (
    <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-300">Simulation</span>
  );
}

/**
 * Every live or simulating property on one screen, with what looks wrong
 * said plainly: its connection, pricing, sending and rules, from one read of
 * platform_pilot_health(). A Live property whose published prices have waited
 * over an hour to be sent has a problem, whatever else reads well. Read-only.
 * Properties with a problem come first,
 * the worse first. Above the table, one line says whether the scheduled
 * syncs' alerts have anywhere to go, from what those functions reported.
 * Nothing polls: the note under the title says when the page was built, and
 * a reload builds it again.
 */
export default async function PilotHealthPage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  const params = await searchParams;
  const includeTest = params.test === "1";
  const ssr = createClient(await cookies());
  const health = await loadPilotHealth(ssr, { includeTest });
  const nowIso = new Date().toISOString();
  const alerts = await alertChannelLine(ssr, nowIso);
  const builtAt = `${nowIso.slice(0, 10)} ${nowIso.slice(11, 16)} UTC`;
  const ago = (iso: string | null) => (iso ? `${ageLabel(iso, nowIso)} ago` : "never");

  const heading = (
    <div>
      <h1 className="text-2xl font-semibold">Pilot health</h1>
      <p className="text-xs text-slate-500">Built at {builtAt}. Reload to refresh.</p>
    </div>
  );

  if (!health.available) {
    return (
      <div className="space-y-6">
        {heading}
        <p className="rounded border border-slate-800 bg-slate-900 px-4 py-3 text-xs text-slate-400">{health.reason}</p>
        <p className={`rounded border px-4 py-3 text-xs ${ALERT_LINE_STYLES[alerts.severity]}`} data-alerts={alerts.verdict}>
          {alerts.text}
        </p>
      </div>
    );
  }

  const entries = health.rows.map((row) => ({ row, assessment: assessProperty(row, nowIso) })).sort(compareAssessed);
  const live = health.rows.filter((r) => r.mode === "live").length;
  const withProblems = entries.filter((e) => e.assessment.problems.length > 0).length;
  const hidden = health.hiddenTest;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        {heading}
        <p className="text-sm text-slate-400">
          {health.rows.length} {health.rows.length === 1 ? "property" : "properties"}, {live} live, {health.rows.length - live} simulating,{" "}
          {withProblems} with a problem.{" "}
          {includeTest ? (
            <Link href="/admin/pilot-health" className="text-slate-500 hover:text-slate-300">
              Test properties are included; hide them
            </Link>
          ) : (
            <Link href="/admin/pilot-health?test=1" className="text-slate-500 hover:text-slate-300">
              {hidden === 0 ? "No test properties hidden" : `${hidden} test ${hidden === 1 ? "property" : "properties"} hidden`}; show them
            </Link>
          )}
        </p>
      </div>

      {health.missing && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">{health.missing}</p>
      )}

      <p className={`rounded border px-4 py-3 text-xs ${ALERT_LINE_STYLES[alerts.severity]}`} data-alerts={alerts.verdict}>
        {alerts.text}
        {alerts.test ? <span className="block mt-1 opacity-80">{alerts.test}</span> : null}
      </p>

      <div className="overflow-hidden rounded border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Property</th>
              <th className="px-4 py-3">Connection</th>
              <th className="px-4 py-3">Pricing</th>
              <th className="px-4 py-3">Sending</th>
              <th className="px-4 py-3">Rules</th>
              <th className="px-4 py-3">Problems</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {entries.map(({ row, assessment }) => (
              <PropertyRow key={row.hotel_id} row={row} assessment={assessment} ago={ago} />
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                  No live or simulating properties.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PropertyRow({
  row,
  assessment,
  ago,
}: {
  row: PilotHealthRow;
  assessment: PropertyAssessment;
  ago: (iso: string | null) => string;
}) {
  const queueStuck = assessment.problems.some((p) => p.kind === "queue");
  const rateReadStuck = assessment.problems.some((p) => p.kind === "rate_read");
  const openTitle = row.open_incident_causes.map((c) => `${humaniseCause(c)}: ${causeFacts(c).adminDescription}`).join("\n");
  return (
    <tr className="align-top hover:bg-slate-800/40">
      <td className="px-4 py-3">
        <Link href={`/admin/hotels/${row.hotel_id}`} className="font-medium text-slate-100 hover:text-sky-300">
          {row.name}
        </Link>
        {row.is_test && <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">test</span>}
        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
          <ModePill mode={row.mode} />
          <span>{row.timezone}</span>
        </div>
      </td>
      <td className="px-4 py-3">
        <PmsStatusPill status={row.pms_status} />
        <div className="mt-1 text-xs text-slate-400">read {ago(row.last_sync_at)}</div>
      </td>
      <td className="px-4 py-3 text-slate-300">
        <div>ran {ago(row.last_ok_run_at)}</div>
        <div className="text-xs text-slate-400">{assessment.pricedThroughText}</div>
        <div className={`text-xs ${queueStuck ? "text-rose-300" : "text-slate-400"}`}>
          {row.dirty_count} in the queue
        </div>
      </td>
      <td className="px-4 py-3 text-slate-300">
        <div>{row.sent_24h} sent in 24h</div>
        <div className={`text-xs ${row.open_incidents > 0 ? "text-rose-300" : "text-slate-400"}`} title={openTitle || undefined}>
          {row.open_incidents} open
        </div>
        {row.open_incidents_admin_only > 0 && (
          <div className="text-xs text-amber-300">{row.open_incidents_admin_only} held by MAYA</div>
        )}
        {(row.unsent_count ?? 0) > 0 && (
          <div className="text-xs text-rose-300">{row.unsent_count} not sent after an hour</div>
        )}
        {(row.rate_read_waiting ?? 0) > 0 && (
          <div className={`text-xs ${rateReadStuck ? "text-rose-300" : "text-amber-300"}`}>
            {row.rate_read_waiting} waiting on a rate read
          </div>
        )}
        {(row.no_rate_count ?? 0) > 0 && (
          <div className="text-xs text-amber-300" title={row.rates_read_through ? `Rates read through ${row.rates_read_through}` : undefined}>
            {row.no_rate_count} with no rate in the PMS
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-slate-300">
        <div>{row.active_rules} active</div>
        <div className="text-xs text-slate-400">{row.rule_changes_24h} changed in 24h</div>
      </td>
      <td className="px-4 py-3">
        {assessment.problems.length === 0 ? (
          <span className="text-xs text-emerald-300">Looks fine</span>
        ) : (
          <ul className="space-y-1 text-xs">
            {assessment.problems.map((p) => (
              <li key={p.kind} className={PROBLEM_STYLES[p.severity]}>
                {p.text}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}
