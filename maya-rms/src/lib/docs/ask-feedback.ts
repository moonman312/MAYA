// The docs helper's only server piece: a reader presses Send and the
// question (or a "this didn't help" note, or a page vote) is stored in the
// docs_questions table (99_supabase_migration_docs_questions_v1.sql), where
// /admin/docs-questions shows it. Kept free of Next.js so the tests can call it.

import { createHash, randomBytes } from "node:crypto";

export const SOURCES = ["unanswered", "not-helpful", "page-useful", "page-not-useful"] as const;
export type Source = (typeof SOURCES)[number];

export const LIMITS = { perHour: 20, bodyBytes: 8_000, question: 500, note: 1_000, page: 200, sections: 1_000 };

const REMOVED = "[removed]";

/**
 * Takes out what should never be stored: email addresses, card-length digit
 * runs (12 to 19 digits, spaces or dashes allowed) and phone-like numbers
 * (9 or more digits with the usual separators).
 */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REMOVED)
    .replace(/(?:\d[ -]?){11,18}\d/g, REMOVED)
    .replace(/\+?\(?\d[\d\s().-]{6,}\d/g, (m) => ((m.match(/\d/g) ?? []).length >= 9 ? REMOVED : m))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim();
}

export interface RateLimiter {
  /** true when this caller may post now (and counts the post) */
  take(ip: string): boolean;
}

/**
 * In-memory limit per SHA-256(ip + a salt that changes every UTC day). The
 * IP itself is never kept, and yesterday's keys cannot be linked to today's.
 */
export function createRateLimiter(opts: { perHour?: number; now?: () => number } = {}): RateLimiter {
  const perHour = opts.perHour ?? LIMITS.perHour;
  const now = opts.now ?? (() => Date.now());
  let day = "";
  let salt = "";
  const hits = new Map<string, number[]>();
  return {
    take(ip: string) {
      const t = now();
      const today = new Date(t).toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        salt = randomBytes(16).toString("hex");
        hits.clear();
      }
      const key = createHash("sha256").update(`${ip}|${salt}`).digest("hex");
      const recent = (hits.get(key) ?? []).filter((x) => t - x < 3_600_000);
      if (recent.length >= perHour) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 50_000) hits.clear();
      return true;
    },
  };
}

/** One row of docs_questions, as the route writes it. */
export interface DocsQuestionRow {
  created_at: string;
  source: Source;
  question: string;
  page: string;
  sections_shown: string;
  note: string;
}

export interface FeedbackDeps {
  limiter: RateLimiter;
  /**
   * The limit for every reader together. Asked only for a post that is valid
   * and within its own reader's limit, so junk and one busy address never use
   * up everybody else's share. True when the post may be stored.
   */
  shared?: () => Promise<boolean>;
  /** stores one row; absent when the database is not configured (local dev) */
  write: ((row: DocsQuestionRow) => Promise<void>) | null;
  now?: () => Date;
  log?: (message: string, err?: unknown) => void;
}

function field(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function handleFeedback(request: Request, deps: FeedbackDeps): Promise<Response> {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > LIMITS.bodyBytes) return new Response(null, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    return new Response(null, { status: 400 });
  }
  const source = body.source as Source;
  if (!SOURCES.includes(source)) return new Response(null, { status: 400 });
  const page = field(body.page, LIMITS.page);
  if (page && !page.startsWith("/")) return new Response(null, { status: 400 });
  const question = scrub(field(body.question, LIMITS.question));
  const note = scrub(field(body.note, LIMITS.note));
  const sections = field(body.sectionsShown, LIMITS.sections)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("/docs"))
    .join(", ");
  if ((source === "unanswered" || source === "not-helpful") && !question) return new Response(null, { status: 400 });
  if ((source === "page-useful" || source === "page-not-useful") && !page) return new Response(null, { status: 400 });

  if (!deps.limiter.take(clientIp(request))) return new Response(null, { status: 429 });
  if (!deps.write) return new Response(null, { status: 204 });
  if (deps.shared && !(await deps.shared())) return new Response(null, { status: 429 });

  const isPageVote = source === "page-useful" || source === "page-not-useful";
  try {
    await deps.write({
      created_at: (deps.now ? deps.now() : new Date()).toISOString(),
      source,
      question: isPageVote ? "" : question,
      page,
      sections_shown: isPageVote ? "" : sections,
      note: isPageVote ? "" : note,
    });
  } catch (err) {
    deps.log?.("docs feedback: storing the row failed", err);
    return new Response(null, { status: 502 });
  }
  return new Response(null, { status: 204 });
}
