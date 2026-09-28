// The docs helper's matcher. Pure functions over the prebuilt index
// (public/docs-index.<hash>.json): no network, no model, no state beyond
// what the caller passes in. See site.md section 9.3.
//
// 1. normalise the question (normalize.ts)
// 2. question-bank pass: compare it with every question a page says it answers
// 3. BM25 over every passage with MiniSearch
// 4. combine per page, pick the passage, and say how sure we are
// 5. a follow-up leans on the last answer's page and question

import MiniSearch from "minisearch";
import { buildSynonymTable, clean, createSpeller, dropAsides, synonymCover, tokenize, trigrams, type SynonymTable } from "./normalize.ts";

export interface AskPage {
  /** url, "/docs/rules/booking-speed" */
  u: string;
  /** title */
  t: string;
  /** keywords, comma separated */
  k: string;
}

export interface AskEntry {
  /** page index */
  p: number;
  /** heading id ("" for the top of the page) */
  a: string;
  /** section title */
  h: string;
  /** bold words the passage opens with, when it is one entry of a list */
  l?: string;
  /** the passage, markdown-lite, cut to what a reader needs */
  x: string;
  /** 1 on the page's In plain words passage */
  ipw?: 1;
  /** 1 when the passage was cut and the rest is on the page */
  m?: 1;
  /** 3 when the heading is an H3 (under an H2) */
  d?: 3;
}

export interface AskQuestion {
  q: string;
  /** page index */
  p: number;
  /** the passage that answers it, when one does */
  e?: number;
}

/** A link a set reply offers: a docs page or one of its headings. */
export interface AskLink {
  href: string;
  /** the page title, or "Page › Heading" */
  label: string;
}

/** One kind of general question and its set reply (content/docs-helper-replies.json). */
export interface AskIntent {
  id: string;
  examples: string[];
  /** the reply, markdown-lite; absent on the page intent, whose reply is built from the page */
  say?: string;
  /** a passage shown under the reply */
  show?: number;
  links?: AskLink[];
  linksTitle?: string;
  /** answers about the page the reader is on */
  page?: true;
}

export interface AskReplies {
  /** words that count for little when comparing and never make a question specific */
  light: string[];
  /** words that never make a question specific */
  neutral: string[];
  /** words dropped before comparing ("um", "so", "please"): they change nothing */
  filler?: string[];
  /** casual spellings, one word to the words the examples use */
  fixes: Record<string, string>;
  /** good starting points, for a question with no answer */
  start: AskLink[];
  /** the MAYA screens whose Help link opens the docs: words for each, and the page it opens */
  areas: Record<string, { label: string; page: number | null }>;
  /** section slug to its label */
  sections: Record<string, string>;
  intents: AskIntent[];
}

export interface AskIndex {
  version: number;
  pages: AskPage[];
  entries: AskEntry[];
  questions: AskQuestion[];
  synonyms: string[][];
  replies?: AskReplies;
}

/**
 * The index as the build writes it (public/docs-index.<hash>.json): sections
 * listed once, passages as [section, text, lead?, more?] with links to docs
 * pages as @<page>, questions as [words, page, passage?]. See `toWire` in
 * scripts/docs/build-lib.mjs.
 */
export interface AskWire {
  v: number;
  p: [string, string, string][];
  s: ([number, string, string] | [number, string, string, 3])[];
  e: ([number, string] | [number, string, string] | [number, string, string, 1])[];
  q: ([string, number] | [string, number, number])[];
  y: string[][];
  r?: AskReplies;
}

/** Unpacks the index the build writes into the shape the matcher reads. */
export function expandIndex(wire: AskWire): AskIndex {
  const pages: AskPage[] = wire.p.map(([u, t, k]) => ({ u, t, k }));
  const opened = new Set<number>();
  const entries: AskEntry[] = wire.e.map(([s, x, l, m]) => {
    const [p, a, h, d] = wire.s[s];
    const e: AskEntry = { p, a, h, x: x.replace(/\]\(@(\d+)/g, (_, i: string) => `](${pages[Number(i)]?.u ?? "/docs"}`) };
    if (l) e.l = l;
    if (m) e.m = 1;
    if (d === 3) e.d = 3;
    if (a === "" && !opened.has(p)) e.ipw = 1;
    if (a === "") opened.add(p);
    return e;
  });
  const questions: AskQuestion[] = wire.q.map(([q, p, e]) => (e === undefined ? { q, p } : { q, p, e }));
  const index: AskIndex = { version: wire.v, pages, entries, questions, synonyms: wire.y };
  if (wire.r) index.replies = wire.r;
  return index;
}

export type Confidence = "high" | "unsure" | "none";

export interface AskHit {
  entry: number;
  page: number;
  score: number;
}

export interface AskResult {
  confidence: Confidence;
  /** 0 to 1: how well the best answer covers the question */
  score: number;
  answer: AskHit | null;
  alsoSee: AskHit[];
  /** pages in rank order, best first (for tests and tuning) */
  pages: AskHit[];
  /** the tokens the question was reduced to */
  tokens: string[];
}

export interface AskContext {
  /** the page of the previous answer, for a follow-up */
  lastPage?: number | null;
  /** the previous question, for a follow-up such as "what about Mews?" */
  lastQuestion?: string | null;
  /** the page the reader is on, a very small nudge */
  currentPage?: number | null;
  /**
   * Reserved for a later in-browser embedding score (site.md 9.8): given a
   * passage index, a similarity from 0 to 1. Blended in when present.
   */
  embeddingScore?: (entry: number) => number;
  /** when given, each candidate page's signals are pushed here (for tuning) */
  debug?: { page: number; bank: number; bm25: number; pageBm: number }[];
}

/** Every tuning number in one place, so the eval can move them together. */
export const TUNING = {
  /** passage fields: page title, section title, bold lead, In plain words, body */
  fields: { t: 0.8, h: 2.2, l: 2, sum: 1.7, x: 1 },
  /** page fields: title, keywords, the questions it answers, all its words */
  pageFields: { t: 0.6, k: 3.2, q: 0.2, all: 0.4 },
  fuzzy: 0.2,
  bankWeight: 0.65,
  bm25Weight: 0.58,
  pageWeight: 0.7,
  /** a bank question this similar answers outright */
  strongBank: 0.8,
  /**
   * added to a bank question typed word for word: "billing" and "Who can see
   * billing?" reduce to the same words, and the one the reader typed wins
   */
  exactBank: 0.05,
  /** within the chosen page, how much a similar question tied to a passage counts next to BM25 */
  entryBank: 0.5,
  /** a passage needs at least this (BM25 plus bank) to be shown instead of In plain words */
  entryFloor: 0.25,
  followUpBoost: 0.08,
  currentPageBoost: 0.02,
  embeddingWeight: 0.3,
  /** coverage counts for this much of the confidence */
  coverWeight: 0.9,
  /** coverage from a single word that is not in the page's title or keywords */
  loneWord: 0.5,
  /** how much a reader's word counts as covered when only a synonym of it is on the page ("max rate" and "ceiling") */
  synonymCover: 0.5,
  /** at or above: a confident answer */
  high: 0.6,
  /** at or above: "This might help"; below: not covered */
  unsure: 0.35,
  /** how many bank questions feed each page's score */
  bankTop: 2,
  secondBank: 0.03,
  /** how much a page's second and third best passages add */
  entrySpread: 0.17,
  /** added to a recipe for "How do I...", or a troubleshooting page for "Why..." */
  intentBoost: 0.25,
  /** add adjacent word pairs as tokens */
  pairs: true,
};

interface PreparedQuestion {
  p: number;
  e?: number;
  tokens: string[];
  tri: Set<string>;
  weight: number;
  /** a listed question's words, cleaned, for an exact match ("" for a heading) */
  exact: string;
}

export interface Matcher {
  index: AskIndex;
  ask(question: string, ctx?: AskContext): AskResult;
  /** the passage a reader would see for a page with no better match */
  introFor(page: number): number;
  /** true when the docs use this word (as the matcher reduces it: lower case, stemmed) */
  knows(token: string): boolean;
}

const FOLLOW_UP = /^(and|also|what about|how about|and what about|same for|what if|but what about|what for|for)\b/;
/** Words a question may open with before it starts ("hi, how do I...", "thanks! and why..."). */
const LEAD_IN = /^((hi|hello|hey|thanks|thank you|thx|ok|okay|so|and|also|please|pls|um|hmm|well|sorry|pardon|excuse me|quick question|question)\s+)+/;

export function isFollowUp(question: string): boolean {
  const q = question.toLowerCase().trim();
  return FOLLOW_UP.test(q) || q.split(/\s+/).length <= 3;
}

export function createMatcher(index: AskIndex, options: { exclude?: (q: AskQuestion) => boolean } = {}): Matcher {
  const syn: SynonymTable = buildSynonymTable(index.synonyms);
  const tok = (s: string) => tokenize(s, syn, { pairs: TUNING.pairs });

  // Every word the docs use, and how often, for reading a misspelt question word as one of them.
  const counts = new Map<string, number>();
  const count = (text: string) => {
    for (const w of clean(text).split(" ")) if (w.length >= 4) counts.set(w, (counts.get(w) ?? 0) + 1);
  };
  for (const e of index.entries) count(`${e.h} ${e.l ?? ""} ${e.x.replace(/\]\([^)]*\)/g, "]")}`);
  for (const p of index.pages) count(`${p.t} ${p.k}`);
  for (const q of index.questions) count(q.q);
  for (const g of index.synonyms) count(g.join(" "));
  const spell = createSpeller(counts);

  // Page-level tokens (title and keywords), shared by the page's passages.
  const pageTitle = index.pages.map((p) => tok(p.t).join(" "));
  const sectionOf = index.pages.map((p) => p.u.split("/")[2] ?? "");
  const pageKeywords = index.pages.map((p) => tok(p.k).join(" "));
  const intro: number[] = index.pages.map(() => -1);
  const pageEntries: number[][] = index.pages.map(() => []);
  index.entries.forEach((e, i) => {
    pageEntries[e.p].push(i);
    if (e.ipw && intro[e.p] === -1) intro[e.p] = i;
  });
  intro.forEach((v, p) => {
    if (v === -1) intro[p] = pageEntries[p][0] ?? 0;
  });

  // Document frequencies over passages, for weighting the bank pass and coverage.
  const df = new Map<string, number>();
  const pageTokens: Set<string>[] = index.pages.map(() => new Set());
  const docs = index.entries.map((e, id) => {
    const body = tok(e.x);
    const doc = {
      id,
      t: pageTitle[e.p],
      h: tok(e.h).join(" "),
      l: e.l ? tok(e.l).join(" ") : "",
      sum: e.ipw ? body.join(" ") : "",
      x: e.ipw ? "" : body.join(" "),
    };
    const seen = new Set([...body, ...doc.h.split(" "), ...doc.l.split(" ")]);
    for (const t of seen) {
      if (!t) continue;
      df.set(t, (df.get(t) ?? 0) + 1);
      pageTokens[e.p].add(t);
    }
    return doc;
  });
  index.pages.forEach((_, p) => {
    for (const t of `${pageTitle[p]} ${pageKeywords[p]}`.split(" ")) if (t) pageTokens[p].add(t);
  });
  const N = index.entries.length;
  const idf = (t: string) => Math.log(1 + N / (1 + (df.get(t) ?? 0)));

  const split = (s: string) => s.split(" ").filter(Boolean);
  const same = (t: string) => t;
  const mini = new MiniSearch({ fields: ["t", "h", "l", "sum", "x"], tokenize: split, processTerm: same });
  mini.addAll(docs);
  // Each page also carries every question it answers, as one field: a page
  // that many questions in the reader's words point at wins on those words.
  const pageQuestions: string[][] = index.pages.map(() => []);

  const questions: PreparedQuestion[] = [];
  for (const q of index.questions) {
    if (options.exclude && options.exclude(q)) continue;
    const tokens = tok(q.q);
    if (!tokens.length) continue;
    const weight = tokens.reduce((n, t) => n + idf(t), 0);
    questions.push({ p: q.p, e: q.e, tokens, tri: trigrams(tokens), weight, exact: clean(q.q) });
    pageQuestions[q.p].push(tokens.join(" "));
  }
  const pageText: string[][] = index.pages.map(() => []);
  docs.forEach((d, i) => pageText[index.entries[i].p].push(d.h, d.l, d.sum, d.x));
  // Question-shaped headings and bold leads ("Why is occupancy over 100%?")
  // are questions the page asks and answers itself; they join the bank.
  const askedHere = new Set<string>();
  index.entries.forEach((e, i) => {
    for (const text of [e.h, e.l]) {
      if (!text || !text.trim().endsWith("?")) continue;
      const key = `${e.p}|${text}`;
      if (askedHere.has(key)) continue;
      askedHere.add(key);
      const tokens = tok(text);
      if (!tokens.length) continue;
      questions.push({ p: e.p, e: i, tokens, tri: trigrams(tokens), weight: tokens.reduce((n, t) => n + idf(t), 0), exact: "" });
    }
  });
  const pageMini = new MiniSearch({ fields: ["t", "k", "q", "all"], tokenize: split, processTerm: same });
  pageMini.addAll(
    index.pages.map((_, id) => ({ id, t: pageTitle[id], k: pageKeywords[id], q: pageQuestions[id].join(" "), all: pageText[id].join(" ") })),
  );

  function bankSimilarity(qTokens: string[], qTri: Set<string>, qWeight: number, b: PreparedQuestion): number {
    const bset = new Set(b.tokens);
    let shared = 0;
    for (const t of new Set(qTokens)) if (bset.has(t)) shared += idf(t);
    if (shared === 0) return 0;
    const overlap = shared / Math.sqrt(qWeight * b.weight);
    let inter = 0;
    for (const g of qTri) if (b.tri.has(g)) inter++;
    const dice = (2 * inter) / (qTri.size + b.tri.size || 1);
    return Math.min(1, 0.75 * overlap + 0.25 * dice);
  }

  // How sure we are that the answer is about the question, 0 to 1. A close
  // match with a question the page lists settles it; otherwise it is how
  // much of the question's weight the passage and its page cover, held down
  // when only one of the reader's words was found (a lone word such as
  // "life" can match by accident).
  function confidenceOf(qTokens: string[], page: number, entry: number, bank: number, synonyms: Map<string, number[]>): number {
    const uniq = [...new Set(qTokens)].filter((t) => !t.startsWith("syn") && !t.includes("_"));
    if (!uniq.length) return Math.min(1, bank);
    // Numbers alone ("2+2", "60") are no question the docs can answer, unless one is listed word for word.
    if (uniq.every((t) => /^\d+$/.test(t))) return bank >= TUNING.strongBank ? Math.min(1, bank) : 0;
    const entryTokens = new Set(
      [docs[entry].t, docs[entry].h, docs[entry].l, docs[entry].sum, docs[entry].x].join(" ").split(" "),
    );
    const topical = new Set(`${pageTitle[page]} ${pageKeywords[page]}`.split(" "));
    let total = 0;
    let inEntry = 0;
    let inPage = 0;
    let found = 0;
    let onTopic = 0;
    for (const t of uniq) {
      const w = idf(t);
      total += w;
      const groups = (synonyms.get(t) ?? []).map((g) => `syn${g}`);
      const has = (set: Set<string>) => (set.has(t) ? 1 : groups.some((g) => set.has(g)) ? TUNING.synonymCover : 0);
      const e = has(entryTokens);
      const p = has(pageTokens[page]);
      inEntry += w * e;
      if (p) {
        inPage += w * p;
        if (!/^\d+$/.test(t)) found++;
      }
      if (has(topical) && !/^\d+$/.test(t)) onTopic++;
    }
    let cover = total ? (0.6 * inEntry + 0.4 * inPage) / total : 0;
    if (found < 2 && onTopic === 0) cover *= TUNING.loneWord;
    return Math.min(1, Math.max(bank, cover * TUNING.coverWeight));
  }

  const RANK: Record<Confidence, number> = { none: 0, unsure: 1, high: 2 };

  /**
   * A short question after another may be a follow-up ("what about Mews?").
   * It is asked on its own first, and keeps that answer when it is a
   * confident one ("is it AI" after "how do I undo a price change?" is its own
   * question). Only a weak match borrows the earlier question's words, and an
   * answer that only borrowed its topic is at most "unsure" unless the
   * question opens like a follow-up.
   */
  function ask(question: string, ctx: AskContext = {}): AskResult {
    if (!ctx.lastQuestion || !isFollowUp(question)) return run(question, ctx, false);
    const opensLikeFollowUp = FOLLOW_UP.test(question.toLowerCase().trim());
    const alone = run(question, ctx, false);
    if (!opensLikeFollowUp && alone.confidence === "high") return alone;
    const borrowed = run(question, ctx, true);
    if (opensLikeFollowUp) return borrowed;
    const capped: AskResult = borrowed.confidence === "high" ? { ...borrowed, confidence: "unsure" } : borrowed;
    return RANK[capped.confidence] > RANK[alone.confidence] ? capped : alone;
  }

  function run(question: string, ctx: AskContext, followUp: boolean): AskResult {
    const spelt = spell(dropAsides(question));
    let tokens = tok(spelt);
    const empty: AskResult = { confidence: "none", score: 0, answer: null, alsoSee: [], pages: [], tokens };
    if (!tokens.length) return empty;

    // A follow-up borrows the words of the question before it.
    const own = new Set(tokens);
    if (followUp) tokens = [...tokens, ...tok(spell(ctx.lastQuestion ?? "")).filter((t) => !own.has(t))];
    const qTri = trigrams(tokens);
    const qWeight = tokens.reduce((n, t) => n + idf(t), 0);

    // Bank pass. Each passage also remembers the closest question tied to it.
    const typed = followUp ? null : clean(question);
    const bankByPage = new Map<number, { sims: number[]; best: PreparedQuestion; bestSim: number }>();
    const bankByEntry = new Map<number, number>();
    for (const b of questions) {
      let s = bankSimilarity(tokens, qTri, qWeight, b);
      if (s <= 0) continue;
      if (b.exact === typed) s += TUNING.exactBank;
      if (b.e !== undefined && s > (bankByEntry.get(b.e) ?? 0)) bankByEntry.set(b.e, s);
      const cur = bankByPage.get(b.p);
      if (!cur) bankByPage.set(b.p, { sims: [s], best: b, bestSim: s });
      else {
        cur.sims.push(s);
        if (s > cur.bestSim) {
          cur.bestSim = s;
          cur.best = b;
        }
      }
    }

    // BM25 passes, over passages and over pages. Words from an earlier question count for half.
    const searchOptions = {
      fuzzy: (term: string) => (term.startsWith("syn") || term.length < 5 ? false : TUNING.fuzzy),
      prefix: (term: string) => !term.startsWith("syn") && term.length >= 5,
      combineWith: "OR" as const,
      tokenize: split,
      processTerm: same,
      boostTerm: (term: string) => (own.has(term) ? 1 : 0.5),
    };
    const on = (w: Record<string, number>) => Object.keys(w).filter((f) => w[f] > 0);
    const results = mini.search(tokens.join(" "), { ...searchOptions, boost: TUNING.fields, fields: on(TUNING.fields) });
    const pageResults = pageMini.search(tokens.join(" "), { ...searchOptions, boost: TUNING.pageFields, fields: on(TUNING.pageFields) });
    const pageTop = pageResults.length ? pageResults[0].score : 0;
    const pageBm = new Map<number, number>(pageResults.map((r) => [r.id as number, pageTop ? r.score / pageTop : 0]));
    const top = results.length ? results[0].score : 0;
    const bestEntryByPage = new Map<number, { entry: number; score: number; others: number[] }>();
    const entryScore = new Map<number, number>();
    for (const r of results) {
      const e = index.entries[r.id as number];
      let score = top ? r.score / top : 0;
      if (ctx.embeddingScore) score = (1 - TUNING.embeddingWeight) * score + TUNING.embeddingWeight * ctx.embeddingScore(r.id as number);
      entryScore.set(r.id as number, score);
      const cur = bestEntryByPage.get(e.p);
      if (!cur) bestEntryByPage.set(e.p, { entry: r.id as number, score, others: [] });
      else if (score > cur.score) {
        cur.others.push(cur.score);
        cur.entry = r.id as number;
        cur.score = score;
      } else cur.others.push(score);
    }

    // Combine per page.
    const candidates = new Set<number>([...bankByPage.keys(), ...bestEntryByPage.keys(), ...pageBm.keys()]);
    const ranked: { page: number; score: number; bank: number; bm25: number; pageBm: number; bankScore: number }[] = [];
    for (const page of candidates) {
      const bank = bankByPage.get(page);
      const sims = bank ? bank.sims.sort((a, b) => b - a).slice(0, TUNING.bankTop) : [];
      const bankScore = sims.length ? sims[0] + (sims[1] ?? 0) * TUNING.secondBank : 0;
      const be = bestEntryByPage.get(page);
      const spread = be ? be.others.sort((a, b) => b - a).slice(0, 2).reduce((n, x) => n + x, 0) : 0;
      const bm = be ? be.score + TUNING.entrySpread * spread : 0;
      const pb = pageBm.get(page) ?? 0;
      let score = TUNING.bankWeight * bankScore + TUNING.bm25Weight * bm + TUNING.pageWeight * pb;
      if (ctx.lastPage === page) score += followUp ? TUNING.followUpBoost * 1.5 : TUNING.followUpBoost;
      if (ctx.currentPage === page) score += TUNING.currentPageBoost;
      ranked.push({ page, score, bank: bank?.bestSim ?? 0, bm25: be?.score ?? 0, pageBm: pb, bankScore });
      if (ctx.debug) ctx.debug.push({ page, bank: bankScore, bm25: bm, pageBm: pb });
    }
    // A question that closely matches one a page lists as its own is answered there.
    // (Pages that tie on it are settled by everything else.)
    let strongest = 0;
    for (const b of bankByPage.values()) strongest = Math.max(strongest, b.bestSim);
    if (strongest >= TUNING.strongBank) {
      for (const r of ranked) if (r.bank >= strongest - 0.03) r.score += 10;
    }
    // "How do I..." leans towards the recipes, "Why..." towards the troubleshooting pages.
    const lead = clean(question).replace(LEAD_IN, "");
    const intent = /^(how (do|can|should) (i|we)|how to|how i can)\b/.test(lead) ? "recipes" : /^why\b/.test(lead) ? "wrong" : null;
    if (intent) for (const r of ranked) if (sectionOf[r.page] === intent) r.score += TUNING.intentBoost;
    ranked.sort((a, b) => b.score - a.score || a.page - b.page);
    if (!ranked.length) return empty;

    // The passage to show on a page: a question that closely matches one tied
    // to a passage settles it; otherwise each passage scores its BM25 plus the
    // closest question tied to it, and In plain words stands in when none
    // scores enough.
    const pick = (page: number): number => {
      const bank = bankByPage.get(page);
      if (bank && bank.bestSim >= TUNING.strongBank) return bank.best.e ?? intro[page];
      let best = intro[page];
      let bestScore = TUNING.entryFloor;
      for (const e of pageEntries[page]) {
        const score = (entryScore.get(e) ?? 0) + TUNING.entryBank * (bankByEntry.get(e) ?? 0);
        if (score > bestScore) {
          bestScore = score;
          best = e;
        }
      }
      return best;
    };

    const hits: AskHit[] = ranked.map((r) => ({ page: r.page, score: r.score, entry: pick(r.page) }));
    const best = ranked[0];
    const answer = hits[0];
    const confidenceScore = confidenceOf(tokens.filter((t) => own.has(t)), best.page, answer.entry, best.bank, synonymCover(spelt, syn));
    const confidence: Confidence =
      confidenceScore >= TUNING.high ? "high" : confidenceScore >= TUNING.unsure ? "unsure" : "none";

    return {
      confidence,
      score: Math.round(confidenceScore * 1000) / 1000,
      answer: confidence === "none" ? null : answer,
      alsoSee: confidence === "none" ? [] : hits.slice(1, 3),
      pages: hits,
      tokens,
    };
  }

  return { index, ask, introFor: (p: number) => intro[p], knows: (t: string) => df.has(t) || pageTokens.some((s) => s.has(t)) };
}
