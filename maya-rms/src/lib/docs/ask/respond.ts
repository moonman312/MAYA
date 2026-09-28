// What the docs helper says to a question: a passage from the docs, a set
// reply, or no answer with somewhere to go next. Pure, over the index; the
// panel (components/docs/ask/ask-panel.tsx) renders it and counts it.
//
// The rule that keeps set replies from answering specific questions:
//
//   1. The question is compared with the set replies' examples (intents.ts).
//   2. A set reply answers when the question matches one AND has no words of
//      its own beyond that intent's examples and the light and neutral lists
//      ("how does this work?", "thanks!", "can I talk to a person?").
//   3. Otherwise the docs answer. "how does booking speed work" has
//      "booking" and "speed", so it is answered from the docs.
//   4. Only when the docs have no answer at all does a matching set reply
//      answer a question with a word of its own ("hi there, xyzzy"): one
//      word at most, and only a reply that is about the conversation (a
//      greeting, thanks, help, a person), never one about a page or MAYA.
//      That reply offers to send the question too. Two words of its own
//      make a subject ("a guest booked at a price that makes no sense"),
//      and a subject with no answer gets no answer, not a set reply.
//   5. Nothing matches: no answer, with the closest pages when there are
//      any worth a look, and a few good places to start.
//
// "this", "it", "here" with no other subject is the page intent: it answers
// about the page the reader is on, or with "it" or "that" the page of the
// last answer, and on the docs home or the support page with the overview.

import { createMatcher, type AskContext, type AskHit, type AskIndex, type AskIntent, type AskLink, type AskResult, type Matcher } from "./match.ts";
import { createIntents, type IntentMatch, type IntentMatcher } from "./intents.ts";

/** What the helper's reply was, as the tally counts it. */
export type Outcome = "answered" | "unsure" | "canned" | "none";

/** Where the reader asked from. */
export interface Place {
  /** the docs page the reader is on, as an index into pages, or null on the docs home or the support page */
  page: number | null;
  /** "home" for /docs, "support" for /support, else the docs section slug */
  section: string;
}

export interface CannedReply {
  intent: string;
  say: string;
  /** a passage shown under the reply */
  show: { entry: number; page: number } | null;
  links: AskLink[];
  linksTitle: string | null;
  /** true when the reply is about a subject, so the reader may still want to send the question */
  offerSend: boolean;
}

export interface Reply {
  outcome: Outcome;
  /** the docs matcher's own result, always present */
  docs: AskResult;
  canned: CannedReply | null;
  /** with no answer: pages that came closest, when any are worth a look */
  closest: AskHit[];
  /** with no answer: good places to start */
  start: AskLink[];
}

export interface RespondContext extends AskContext {
  place?: Place;
  /** the MAYA screen whose Help link opened the docs in this tab, when there was one */
  appArea?: string | null;
}

/** A no-answer reply shows its closest pages only at or above this confidence score. */
export const CLOSEST_FLOOR = 0.2;
/** Intents whose reply is about a subject: the reader may still send the question. */
const SUBJECT_INTENTS = new Set(["page", "overview", "start"]);
/** With no answer in the docs, a set reply about the conversation may still take a question with this many words of its own. */
const STRAY_WORDS = 1;
/** Words that point at the page the reader is on, and at these docs as a whole. */
const PAGE_WORDS = /\b(page|here|screen|tab)\b/;
const SITE_WORDS = /\b(site|website|docs|documentation|place)\b/;

export interface Helper {
  index: AskIndex;
  matcher: Matcher;
  intents: IntentMatcher | null;
  respond(question: string, ctx?: RespondContext): Reply;
}

/** The place for a pathname: /docs, /support, /docs/<section>/<page>. A section the docs do not have counts as the docs home. */
export function placeFor(index: AskIndex, pathname: string): Place {
  const path = pathname.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
  if (path === "/support") return { page: null, section: "support" };
  const known = (slug: string) => !index.replies || slug in index.replies.sections;
  const page = index.pages.findIndex((p) => p.u === path);
  const slug = /^\/docs\/([a-z0-9-]+)/.exec(path)?.[1] ?? "";
  const section = slug && known(slug) ? slug : "home";
  return { page: page >= 0 ? page : null, section };
}

export function createHelper(index: AskIndex, matcher: Matcher = createMatcher(index)): Helper {
  const replies = index.replies ?? null;
  const intents = replies ? createIntents(replies, matcher.knows) : null;
  const overviewPage = index.pages.findIndex((p) => p.u === "/docs/start/what-maya-does");

  /** The H2 headings of a page, as links, in page order. */
  function outline(page: number, max = 6): AskLink[] {
    const seen = new Set<string>();
    const out: AskLink[] = [];
    for (const e of index.entries) {
      if (e.p !== page || !e.a || e.d === 3 || seen.has(e.a)) continue;
      seen.add(e.a);
      out.push({ href: `${index.pages[page].u}#${e.a}`, label: e.h });
      if (out.length >= max) break;
    }
    return out;
  }

  function aboutDocs(intent: AskIntent): CannedReply {
    return {
      intent: intent.id,
      say: "These docs explain MAYA, from signing up to going live. Here it is in a few lines.",
      show: overviewPage >= 0 ? { entry: matcher.introFor(overviewPage), page: overviewPage } : null,
      links: replies?.start ?? [],
      linksTitle: "Good places to start",
      offerSend: true,
    };
  }

  function aboutPage(intent: AskIntent, question: string, ctx: RespondContext): CannedReply {
    const q = question.toLowerCase();
    const place = ctx.place ?? { page: ctx.currentPage ?? null, section: "" };
    let page: number | null;
    let current: boolean;
    if (SITE_WORDS.test(q)) return aboutDocs(intent);
    if (PAGE_WORDS.test(q) || ctx.lastPage == null) {
      page = place.page;
      current = true;
    } else {
      page = ctx.lastPage;
      current = page === place.page;
    }
    if (page == null || !index.pages[page]) return aboutDocs(intent);
    const p = index.pages[page];
    const sectionLabel = replies?.sections[p.u.split("/")[2] ?? ""];
    const area = ctx.appArea && replies?.areas[ctx.appArea];
    const cameFrom = current && area && area.page === page ? `You opened Help from ${area.label} in MAYA. ` : "";
    const say = current
      ? `${cameFrom}You're reading **${p.t}**${sectionLabel ? `, in ${sectionLabel}` : ""}. In short:`
      : `**${p.t}**, in short:`;
    const links = outline(page);
    return {
      intent: intent.id,
      say,
      show: { entry: matcher.introFor(page), page },
      links,
      linksTitle: links.length ? (current ? "On this page" : "On that page") : null,
      offerSend: true,
    };
  }

  function canned(m: IntentMatch, question: string, ctx: RespondContext): CannedReply {
    const intent = m.intent;
    if (intent.page) return aboutPage(intent, question, ctx);
    const show = intent.show !== undefined && index.entries[intent.show] ? { entry: intent.show, page: index.entries[intent.show].p } : null;
    return {
      intent: intent.id,
      say: intent.say ?? "",
      show,
      links: intent.links ?? [],
      linksTitle: intent.linksTitle ?? null,
      offerSend: SUBJECT_INTENTS.has(intent.id),
    };
  }

  function respond(question: string, ctx: RespondContext = {}): Reply {
    const currentPage = ctx.currentPage ?? ctx.place?.page ?? null;
    const docs = matcher.ask(question, { ...ctx, currentPage });
    const m = intents ? intents.match(question) : null;
    const base = { docs, closest: [] as AskHit[], start: [] as AskLink[] };
    const stray = docs.confidence === "none" && !SUBJECT_INTENTS.has(m?.intent.id ?? "") && (m?.residual.length ?? 0) <= STRAY_WORDS;
    if (m && (m.residual.length === 0 || stray)) {
      const c = canned(m, question, { ...ctx, currentPage });
      // A word the set reply does not cover may be what the reader meant.
      if (m.residual.length) c.offerSend = true;
      return { ...base, outcome: "canned", canned: c };
    }
    if (docs.confidence !== "none") {
      return { ...base, outcome: docs.confidence === "high" ? "answered" : "unsure", canned: null };
    }
    const closest = docs.score >= CLOSEST_FLOOR ? docs.pages.slice(0, 2) : [];
    const shown = new Set(closest.map((h) => index.pages[h.page].u));
    return {
      ...base,
      outcome: "none",
      canned: null,
      closest,
      start: (replies?.start ?? []).filter((l) => !shown.has(l.href)).slice(0, 4),
    };
  }

  return { index, matcher, intents, respond };
}
