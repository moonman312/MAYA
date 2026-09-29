import { PmsStatusPill } from "@/components/admin/status-pill";
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
 * platform_pilot_health(). Read-only. Properties with a problem come first,
 * the worse first. Nothing polls: the note under the title says when the
 * page was built, and a reload builds it again.
 */
export default async function PilotHealthPage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  const params = await searchParams;
  const includeTest = params.test === "1";
  const ssr = createClient(await cookies());
  const health = await loadPilotHealth(ssr, { includeTest });
  const nowIso = new Date().toISOString();
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
