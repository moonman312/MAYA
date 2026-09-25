import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";

export const dynamic = "force-dynamic";

// What docs readers chose to send from the docs helper and the "Was this page
// useful?" buttons. Written by POST /api/docs-ask/feedback; the text is
// scrubbed before it is stored. The layout already checks platform admin, and
// RLS lets only platform admins read the table.

const SOURCES = [
  { key: "", label: "Everything" },
  { key: "unanswered", label: "Not answered" },
  { key: "not-helpful", label: "Didn't help" },
  { key: "page-not-useful", label: "Page not useful" },
  { key: "page-useful", label: "Page useful" },
] as const;

const SOURCE_LABEL: Record<string, string> = {
  unanswered: "Not answered",
  "not-helpful": "Didn't help",
  "page-useful": "Page useful",
  "page-not-useful": "Page not useful",
};

type Row = {
  id: number;
  created_at: string;
  source: string;
  question: string;
  page: string;
  sections_shown: string;
  note: string;
  signed_in: boolean;
};

const LIMIT = 300;

export default async function AdminDocsQuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  const raw = (await searchParams).source;
  const source = SOURCES.some((s) => s.key === raw) && typeof raw === "string" ? raw : "";

  const ssr = createClient(await cookies());
  let query = ssr
    .from("docs_questions")
    .select("id, created_at, source, question, page, sections_shown, note, signed_in")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (source) query = query.eq("source", source);
  const { data, error } = await query;
  const rows = (data ?? []) as Row[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Docs questions</h1>
        <p className="text-sm text-slate-400">
          What readers sent from the docs at /docs: questions the helper could not answer, answers that did not help, and page
          votes. Newest first, up to {LIMIT}.
        </p>
      </div>

      <nav className="flex flex-wrap gap-2 text-sm">
        {SOURCES.map((s) => (
          <Link
            key={s.key || "all"}
            href={s.key ? `/admin/docs-questions?source=${s.key}` : "/admin/docs-questions"}
            className={`rounded px-3 py-1.5 ${
              s.key === source ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
            }`}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      {error ? (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          Could not read docs_questions: {error.message}. If the table is missing, run
          99_supabase_migration_docs_questions_v1.sql.
        </div>
      ) : null}

      <div className="overflow-hidden rounded border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Question and note</th>
              <th className="px-4 py-3">Page</th>
              <th className="px-4 py-3">Shown</th>
              <th className="px-4 py-3">Reader</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 align-top">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-800/40">
                <td className="whitespace-nowrap px-4 py-3 text-slate-400">{new Date(r.created_at).toLocaleString()}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-300">{SOURCE_LABEL[r.source] ?? r.source}</td>
                <td className="px-4 py-3 text-slate-100">
                  {r.question ? <p>{r.question}</p> : <span className="text-slate-600">None</span>}
                  {r.note ? <p className="mt-1 text-slate-400">Note: {r.note}</p> : null}
                </td>
                <td className="px-4 py-3">
                  {r.page.startsWith("/docs") ? (
                    <a href={r.page} target="_blank" rel="noopener" className="text-sky-300 hover:underline">
                      {r.page}
                    </a>
                  ) : (
                    <span className="text-slate-400">{r.page || "None"}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">
                  {r.sections_shown
                    ? r.sections_shown.split(", ").map((s) => (
                        <a key={s} href={s} target="_blank" rel="noopener" className="block text-sky-300/80 hover:underline">
                          {s}
                        </a>
                      ))
                    : null}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-400">{r.signed_in ? "Signed in" : "Visitor"}</td>
              </tr>
            ))}
            {rows.length === 0 && !error ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                  Nothing sent yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
