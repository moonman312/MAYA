import Link from "next/link";
import {
  OUTCOME_LABEL,
  percent,
  TALLY_OUTCOMES,
  type PlaceLine,
  type TallyTotals,
  type WeeklyTally,
} from "@/lib/admin/docs-tally";

// The docs helper's anonymous count on the Command Center: a tile on /admin
// for the last 30 days, and the weekly tables on /admin/docs-questions.

const MIGRATION = "99_supabase_migration_docs_ask_tally_v1.sql";

/** "Sep 21" for the week starting on that Monday. */
function weekLabel(monday: string): string {
  return new Date(`${monday}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const n = (x: number) => x.toLocaleString("en-US");

/** The Command Center tile: questions asked in the last 30 days, the share answered, and how often there was no answer. */
export function DocsTallyTile({ totals, error }: { totals: TallyTotals | null; error?: string | null }) {
  return (
    <Link
      href="/admin/docs-questions"
      className="block rounded border border-slate-800 bg-slate-900 p-4 transition hover:border-slate-700"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs uppercase tracking-wide text-slate-500">Docs helper, last 30 days</h2>
        <span className="text-xs text-sky-300">Details →</span>
      </div>
      {totals ? (
        <dl className="mt-2 grid grid-cols-3 gap-4">
          <div>
            <dt className="text-xs text-slate-400">Questions asked</dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-100">{n(totals.asked)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Answered</dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-100">{percent(totals.answeredShare)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">No answer</dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-100">
              {n(totals.byOutcome.none)}
              <span className="ml-1.5 text-sm font-normal text-slate-400">{percent(totals.noneShare)}</span>
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-amber-200">
          Could not read the count{error ? `: ${error}` : ""}. If the table is missing, run {MIGRATION}.
        </p>
      )}
    </Link>
  );
}

const TH = "px-3 py-2 text-right font-medium";
const TD = "px-3 py-2 text-right tabular-nums";

function PlaceTable({ title, first, weeks, lines, empty }: { title: string; first: string; weeks: string[]; lines: PlaceLine[]; empty: string }) {
  return (
    <div className="overflow-hidden rounded border border-slate-800 bg-slate-900">
      <h3 className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-slate-200">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{first}</th>
              {weeks.map((w) => (
                <th key={w} className={`${TH} whitespace-nowrap normal-case`}>
                  {weekLabel(w)}
                </th>
              ))}
              <th className={TH}>Total</th>
              <th className={TH}>No answer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-300">
            {lines.map((l) => (
              <tr key={l.key}>
                <td className="whitespace-nowrap px-3 py-2 text-left text-slate-200">{l.label}</td>
                {l.perWeek.map((x, i) => (
                  <td key={weeks[i]} className={`${TD} ${x ? "" : "text-slate-600"}`}>
                    {n(x)}
                  </td>
                ))}
                <td className={`${TD} font-semibold text-slate-100`}>{n(l.asked)}</td>
                <td className={TD}>
                  {n(l.none)} <span className="text-slate-500">{percent(l.asked ? l.none / l.asked : null)}</span>
                </td>
              </tr>
            ))}
            {lines.length === 0 ? (
              <tr>
                <td colSpan={weeks.length + 3} className="px-4 py-6 text-center text-slate-500">
                  {empty}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** /admin/docs-questions: every question asked in the docs helper, week by week. */
export function DocsTallyWeekly({ tally, error }: { tally: WeeklyTally | null; error?: string | null }) {
  if (!tally) {
    return (
      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
        Could not read the question count{error ? `: ${error}` : ""}. If the table is missing, run {MIGRATION}.
      </div>
    );
  }
  const total = tally.lines.reduce((a, l) => a + l.asked, 0);
  const lines = [...tally.lines].reverse();
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Questions asked, last 12 weeks</h2>
        <p className="text-sm text-slate-400">
          Every question asked in the docs helper, by everyone, signed in or not. Only the kind of reply and where it was asked are
          counted, never the question. Weeks start on Monday (UTC).
        </p>
      </div>

      <div className="overflow-hidden rounded border border-slate-800 bg-slate-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Week of</th>
                <th className={TH}>Asked</th>
                {TALLY_OUTCOMES.map((o) => (
                  <th key={o} className={TH}>
                    {OUTCOME_LABEL[o]}
                  </th>
                ))}
                <th className={TH}>No answer share</th>
                <th className={TH}>Signed in</th>
                <th className={TH}>Signed out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {lines.map((l) => (
                <tr key={l.week} className={l.asked ? "" : "text-slate-600"}>
                  <td className="whitespace-nowrap px-3 py-2 text-left text-slate-200">{weekLabel(l.week)}</td>
                  <td className={`${TD} font-semibold text-slate-100`}>{n(l.asked)}</td>
                  {TALLY_OUTCOMES.map((o) => (
                    <td key={o} className={TD}>
                      {n(l.byOutcome[o])}
                    </td>
                  ))}
                  <td className={TD}>{percent(l.asked ? l.byOutcome.none / l.asked : null)}</td>
                  <td className={TD}>{n(l.signedIn)}</td>
                  <td className={TD}>{n(l.signedOut)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total === 0 ? <p className="border-t border-slate-800 px-4 py-4 text-sm text-slate-500">No questions asked yet.</p> : null}
      </div>

      <PlaceTable title="Where it was asked" first="Docs" weeks={tally.weeks} lines={tally.places} empty="Nothing yet." />
      <PlaceTable
        title="Opened from Help in MAYA"
        first="Screen"
        weeks={tally.weeks}
        lines={tally.areas}
        empty="No questions yet from docs opened with Help in MAYA."
      />
    </section>
  );
}
