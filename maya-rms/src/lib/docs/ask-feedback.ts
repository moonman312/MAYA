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
    // half an emoji (a lone surrogate) would make Postgres refuse the whole row
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
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

export type SharedBudget = "question" | "vote";

/**
 * Which limit refused a post, so the reader is told the truth: "you" sent a
 * lot from one address, or "everyone" together used up the hour.
 */
export type LimitedBy = "you" | "everyone";

function limited(by: LimitedBy): Response {
  return Response.json({ limited: by }, { status: 429, headers: { "Retry-After": "3600" } });
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
   * The limit for every reader together, one budget for questions and notes
   * and another for page votes, so votes can never use up the room for
   * questions. Asked only for a post that is valid and within its own reader's
   * limit, so junk and one busy address never use up everybody else's share.
   * True when the post may be stored.
   */
  shared?: (budget: SharedBudget) => Promise<boolean>;
  /** stores one row; absent when the database is not configured (local dev) */
  write: ((row: DocsQuestionRow) => Promise<void>) | null;
  now?: () => Date;
  log?: (message: string, err?: unknown) => void;
}

/**
 * At most `max` characters as Postgres counts them (code points), so the
 * table's length checks always hold and a cut never splits an emoji.
 */
function cut(text: string, max: number): string {
  // A string's .length is never below its code point count, so this is safe.
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

function field(value: unknown, max: number): string {
  return typeof value === "string" ? cut(value, max) : "";
}

/**
 * Free text as stored: scrubbed first and cut after, because scrubbing can
 * make text longer (a 7-character email becomes the 9 of "[removed]"). Very
 * long text is first trimmed to twice the limit at a word break, which bounds
 * the scrubbing work and never hands the scrub half an email it would miss.
 */
function freeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let text = value;
  if (text.length > max * 2) {
    text = text.slice(0, max * 2);
    const lastWord = text.search(/\S*$/);
    if (lastWord > 0) text = text.slice(0, lastWord);
  }
  return cut(scrub(text), max);
}

/** The docs pages the helper showed, kept whole: only /docs paths, joined within the limit. */
function pageList(value: unknown): string {
  if (typeof value !== "string") return "";
  let raw = value;
  // Trimmed first to bound the work; a path cut in half by the trim is dropped.
  if (raw.length > LIMITS.sections * 2) raw = raw.slice(0, LIMITS.sections * 2).replace(/[^,]*$/, "");
  const kept: string[] = [];
  let length = 0;
  for (const item of raw.split(",")) {
    const path = item.trim();
    if (!path.startsWith("/docs")) continue;
    const added = (kept.length ? 2 : 0) + path.length;
    if (length + added > LIMITS.sections) break;
    kept.push(path);
    length += added;
  }
  return kept.join(", ");
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
  const question = freeText(body.question, LIMITS.question);
  const note = freeText(body.note, LIMITS.note);
  const sections = pageList(body.sectionsShown);
  if ((source === "unanswered" || source === "not-helpful") && !question) return new Response(null, { status: 400 });
  if ((source === "page-useful" || source === "page-not-useful") && !page) return new Response(null, { status: 400 });

  const isPageVote = source === "page-useful" || source === "page-not-useful";
  if (!deps.limiter.take(clientIp(request))) return limited("you");
  if (!deps.write) return new Response(null, { status: 204 });
  if (deps.shared && !(await deps.shared(isPageVote ? "vote" : "question"))) return limited("everyone");

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
