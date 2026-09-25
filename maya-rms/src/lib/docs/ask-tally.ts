// The docs helper's anonymous count: every question a reader asks adds one
// row to docs_ask_tally (99_supabase_migration_docs_ask_tally_v1.sql) with
// what kind of reply it got, whether the reader was signed in, and where it
// was asked. No question text, no user id, no IP, no property, and the day
// only, not the time. /admin and /admin/docs-questions read it.
// Kept free of Next.js so the tests can call it.

import sections from "./sections.json";
import registry from "../deep-links/registry.json";
import { createRateLimiter, type RateLimiter } from "./ask-feedback";

export const OUTCOMES = ["answered", "unsure", "canned", "none"] as const;
export type TallyOutcome = (typeof OUTCOMES)[number];

/** Where a question can be asked: the docs home, the support page, or a docs section. */
export const PLACES: readonly string[] = ["home", "support", ...sections.map((s) => s.slug)];
/** The MAYA screens whose Help link opens the docs (lib/deep-links/registry.json). */
export const APP_AREAS: readonly string[] = Object.keys(registry.help.screens);

/**
 * One reader asks a question every few seconds at most; this is only the
 * ceiling for a loop. Separate from the feedback route's limits, so counting
 * never uses up the room for sent questions.
 */
export const TALLY_PER_HOUR = 240;
const BODY_BYTES = 1_000;

/** One row of docs_ask_tally, as the route writes it. */
export interface DocsAskTallyRow {
  /** the UTC day, YYYY-MM-DD */
  asked_on: string;
  outcome: TallyOutcome;
  signed_in: boolean;
  section: string;
  app_area: string;
}

export interface TallyDeps {
  limiter: RateLimiter;
  /** the limit for every reader together (its own budget); true when the row may be stored */
  shared?: () => Promise<boolean>;
  /** whether the reader is signed in to MAYA, asked only for a row that will be stored */
  signedIn?: () => Promise<boolean>;
  /** stores one row; absent when the database is not configured (local dev) */
  write: ((row: DocsAskTallyRow) => Promise<void>) | null;
  now?: () => Date;
  log?: (message: string, err?: unknown) => void;
}

export function createTallyLimiter(opts: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({ perHour: TALLY_PER_HOUR, now: opts.now });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function handleTally(request: Request, deps: TallyDeps): Promise<Response> {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > BODY_BYTES) return new Response(null, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    return new Response(null, { status: 400 });
  }
  const outcome = body.outcome as TallyOutcome;
  if (!OUTCOMES.includes(outcome)) return new Response(null, { status: 400 });
  const section = typeof body.section === "string" && PLACES.includes(body.section) ? body.section : "";
  if (!section) return new Response(null, { status: 400 });
  // An app area the registry does not know is dropped, never stored as sent.
  const appArea = typeof body.appArea === "string" && APP_AREAS.includes(body.appArea) ? body.appArea : "";

  if (!deps.limiter.take(clientIp(request))) return new Response(null, { status: 429 });
  if (!deps.write) return new Response(null, { status: 204 });
  if (deps.shared && !(await deps.shared())) return new Response(null, { status: 429 });

  try {
    await deps.write({
      asked_on: (deps.now ? deps.now() : new Date()).toISOString().slice(0, 10),
      outcome,
      signed_in: deps.signedIn ? await deps.signedIn() : false,
      section,
      app_area: appArea,
    });
  } catch (err) {
    deps.log?.("docs tally: storing the row failed", err);
    return new Response(null, { status: 502 });
  }
  return new Response(null, { status: 204 });
}
