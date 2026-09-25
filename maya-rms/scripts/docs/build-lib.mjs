// The docs build, as pure functions over file contents so the tests can feed
// it pages without touching the disk. scripts/docs-build.mjs does the I/O.

import { createHash } from "node:crypto";
import { splitFrontmatter, stripTrailingNotes, parseFrontmatter, splitRef } from "../../src/lib/docs/source.mjs";
import { extractPage, mdToPlain, wordCount } from "./extract.mjs";
import { scanText } from "./leaks.mjs";

export const WORDS_PER_MINUTE = 200;
export const PASSAGE_MAX = 1200;
export const EVAL_SIZE = 150;
const PMS = ["cloudbeds", "thinkreservations", "mews"];
const KNOWN_KEYS = new Set([
  "title", "summary", "section", "order", "readingTime", "readingNote", "keywords", "questions", "pms", "updated",
]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The docs live in the app, so a bare "/" would be the dashboard: the only
// other page here is /support. The marketing site's pages are written out in
// full (https://www.get-maya.com/privacy).
const SITE_PAGES = new Set(["/support"]);

export function readingTimeFor(words) {
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

function isStringList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "");
}

/** Checks one page's frontmatter against the schema; returns problem strings. */
export function validateFrontmatter(fm, sectionSlugs) {
  const out = [];
  const need = (key, ok, what) => {
    if (fm[key] === undefined) out.push(`missing "${key}"`);
    else if (!ok(fm[key])) out.push(`"${key}" should be ${what}`);
  };
  need("title", (v) => typeof v === "string" && v.trim() !== "", "a line of text");
  need("summary", (v) => typeof v === "string" && v.trim() !== "", "one sentence");
  need("section", (v) => typeof v === "string", "a section slug");
  need("order", (v) => typeof v === "number", "a number");
  need("keywords", (v) => isStringList(v) && v.length > 0, "a list of words");
  need("questions", (v) => isStringList(v) && v.length >= 3, "a list of at least three questions");
  if (typeof fm.section === "string" && !sectionSlugs.includes(fm.section)) {
    out.push(`unknown section "${fm.section}" (one of: ${sectionSlugs.join(", ")})`);
  }
  if (fm.readingTime !== undefined && !(typeof fm.readingTime === "number" && fm.readingTime >= 1)) {
    out.push(`"readingTime" should be a whole number of minutes`);
  }
  if (fm.readingNote !== undefined && typeof fm.readingNote !== "string") out.push(`"readingNote" should be text`);
  if (fm.pms !== undefined && !(isStringList(fm.pms) && fm.pms.every((p) => PMS.includes(p)))) {
    out.push(`"pms" should list only ${PMS.join(", ")}`);
  }
  if (fm.updated !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(fm.updated))) {
    out.push(`"updated" should be a date like 2026-09-24`);
  }
  for (const key of Object.keys(fm)) if (!KNOWN_KEYS.has(key)) out.push(`unknown frontmatter key "${key}"`);
  return out;
}

/**
 * Reads every page. `files` is [{ file: "rules/booking-speed.mdx", raw }].
 * Returns { pages, problems } with problems as { file, line, message }.
 */
export function loadPages(files, sectionList) {
  const sectionSlugs = sectionList.map((s) => s.slug);
  const problems = [];
  const pages = [];
  const seen = new Set();
  for (const { file, raw } of files) {
    const say = (message, line = 0) => problems.push({ file, line, message });
    const m = file.match(/^([^/]+)\/([^/]+)\.mdx$/);
    if (!m) {
      say("pages live at content/docs/<section>/<page>.mdx");
      continue;
    }
    const [, folder, slug] = m;
    if (!SLUG.test(slug)) say(`"${slug}" is not a kebab-case slug`);
    const { frontmatter, body: rawBody, bodyLine } = splitFrontmatter(raw);
    if (frontmatter === null) {
      say("no frontmatter block");
      continue;
    }
    let fm;
    try {
      fm = parseFrontmatter(frontmatter);
    } catch (err) {
      say(err.message);
      continue;
    }
    // A question may end with {#anchor}, the passage that answers it. The
    // rest of the build sees the question's words only.
    const asked = isStringList(fm.questions) ? fm.questions.map(splitRef) : [];
    if (asked.length) fm.questions = asked.map((a) => a.text);
    for (const p of validateFrontmatter(fm, sectionSlugs)) say(p, 1);
    if (fm.section !== folder) say(`section "${fm.section}" does not match its folder "${folder}"`, 1);
    const path = `${folder}/${slug}`;
    if (seen.has(path)) say(`duplicate page ${path}`);
    seen.add(path);

    const body = stripTrailingNotes(rawBody);
    for (const hit of scanText(`${frontmatter}\n${body}`)) {
      const line = hit.line <= frontmatter.split("\n").length ? hit.line + 1 : hit.line - frontmatter.split("\n").length + bodyLine - 1;
      say(`${hit.name} "${hit.found}" in ...${hit.context}...`, line);
    }

    let extract;
    try {
      extract = extractPage(body, { path, lineOffset: bodyLine - 1 });
    } catch (err) {
      const line = err.line ? err.line + bodyLine - 1 : 0;
      say(`can't read the page as MDX: ${err.reason || err.message}`, line);
      continue;
    }
    for (const p of extract.problems) say(p.message, p.line);

    const plain = extract.sections.map((s) => [s.title, ...s.blocks.map((b) => b.md)].join("\n")).map(mdToPlain).join("\n\n");
    const words = wordCount(plain);
    pages.push({
      file,
      path,
      asked,
      url: `/docs/${path}`,
      section: fm.section,
      slug,
      fm,
      raw,
      body,
      extract,
      plain,
      words,
      readingTime: readingTimeFor(words),
    });
  }

  const sectionOrder = new Map(sectionSlugs.map((s, i) => [s, i]));
  pages.sort(
    (a, b) =>
      (sectionOrder.get(a.section) ?? 99) - (sectionOrder.get(b.section) ?? 99) ||
      (a.fm.order ?? 0) - (b.fm.order ?? 0) ||
      a.slug.localeCompare(b.slug),
  );

  // Links: every /docs link must reach a page, and an #anchor a heading on it.
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  for (const page of pages) {
    for (const link of page.extract.links) {
      const say = (message) => problems.push({ file: page.file, line: link.line, message });
      const url = link.url;
      if (url.startsWith("#")) {
        if (!page.extract.allIds.includes(url.slice(1))) say(`link "${url}" points at no heading on this page`);
        continue;
      }
      if (url.startsWith("/docs")) {
        const [pathPart, anchor] = url.split("#");
        const target = byUrl.get(pathPart.replace(/\/$/, ""));
        if (pathPart === "/docs" || pathPart === "/docs/") continue;
        if (!target) {
          say(`link "${url}" points at a page that does not exist`);
          continue;
        }
        if (anchor && !target.extract.allIds.includes(anchor)) say(`link "${url}" points at no heading on ${target.path}`);
        continue;
      }
      if (url.startsWith("/")) {
        if (!SITE_PAGES.has(url.split("#")[0])) say(`link "${url}" is not a docs page or a site page`);
        continue;
      }
      if (/^https?:\/\/(www\.)?maya-rms\.com(\/|$)/i.test(url)) {
        say(`link "${url}" goes into MAYA for everyone: use <AppLink to="..."> so only signed-in readers get it`);
        continue;
      }
      if (!/^(https?:|mailto:)/.test(url)) say(`link "${url}" should start with /docs/, https:// or mailto:`);
    }
  }

  return { pages, problems };
}

/** Splits a section's blocks into passages of at most about PASSAGE_MAX characters. */
export function chunkBlocks(blocks, max = PASSAGE_MAX) {
  const leadCount = blocks.filter((b) => b.lead && !b.callout).length;
  const chunks = [];
  let cur = null;
  const size = (c) => c.parts.reduce((n, p) => n + p.length + 2, 0);
  const start = (lead) => {
    cur = { lead, parts: [] };
    chunks.push(cur);
  };
  for (const b of blocks) {
    const isEntry = leadCount >= 2 && b.lead && !b.callout;
    if (!cur || isEntry || (size(cur) + b.md.length > max && cur.parts.length > 0)) {
      start(isEntry ? b.lead : undefined);
    }
    cur.parts.push(b.md);
  }
  // A short lead-in ("Three things to expect:") joins the passage after it.
  for (let i = chunks.length - 2; i >= 0; i--) {
    const c = chunks[i];
    if (!c.lead && size(c) < 200) {
      chunks[i + 1].parts.unshift(...c.parts);
      chunks.splice(i, 1);
    }
  }
  // Consecutive list items read as one list.
  return chunks
    .map((c) => ({
      lead: c.lead,
      md: c.parts
        .reduce((acc, part, i) => {
          if (i === 0) return part;
          const prevIsItem = /^(?:-|\d+\.) /.test(c.parts[i - 1]);
          const isItem = /^(?:-|\d+\.) /.test(part);
          return acc + (prevIsItem && isItem ? "\n" : "\n\n") + part;
        }, "")
        .trim(),
    }))
    .filter((c) => c.md !== "");
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Page list for navigation, metadata, "On this page" and the helper's starters. */
export function buildPagesMeta(pages, sectionList) {
  const label = new Map(sectionList.map((s) => [s.slug, s.label]));
  return pages.map((p) => ({
    path: p.path,
    url: p.url,
    section: p.section,
    sectionLabel: label.get(p.section),
    slug: p.slug,
    order: p.fm.order,
    title: p.fm.title,
    summary: p.fm.summary,
    readingTime: p.readingTime,
    readingNote: p.fm.readingNote || null,
    updated: p.fm.updated ? String(p.fm.updated) : null,
    pms: p.fm.pms || [],
    headings: p.extract.headings,
    questions: p.fm.questions,
    faq: p.section === "wrong" ? faqFor(p) : [],
  }));
}

// Question-shaped headings and the first paragraph under each, for FAQ markup.
function faqFor(page) {
  return page.extract.sections
    .filter((s) => s.depth >= 2 && s.title.trim().endsWith("?"))
    .map((s) => {
      const first = s.blocks.find((b) => !b.callout && !b.table && !b.widget && !b.item);
      return first ? { q: s.title, a: mdToPlain(first.md) } : null;
    })
    .filter(Boolean);
}

/** The site search index: one record per page. */
export function buildSearchIndex(pages, sectionList) {
  const label = new Map(sectionList.map((s) => [s.slug, s.label]));
  return {
    pages: pages.map((p) => ({
      u: p.url,
      t: p.fm.title,
      s: label.get(p.section),
      sum: p.fm.summary,
      h: p.extract.headings.map((h) => h.text),
      hid: p.extract.headings.map((h) => h.id),
      k: p.fm.keywords.join(", "),
    })),
  };
}

// ── The docs helper's index ─────────────────────────────────────────

/** The ref that names a page's In plain words box. */
export const IPW_REF = "in-plain-words";
/**
 * The helper shows a passage cut to about this many characters, at a
 * paragraph or list item where it can, and links to the page for the rest.
 */
export const PASSAGE_SHOWN = 900;
/** A passage holding a table may run this much past the cut and still show whole (900 becomes 1500). */
export const TABLE_ALLOWANCE = 5 / 3;

const QUESTION_STOP = new Set(
  (
    "a an the is are was were be been do does did i me my we us our you your it its they them their this that these those " +
    "what which who how when where why of to in on at for with from by about as into than then so if or and but can could " +
    "would should will may might must just also any some all each every very too much many more most other such only own " +
    "same still get need not no yes there here has have had"
  ).split(" "),
);

/** Rough words for telling apart the passages under one heading. */
export function roughWords(text) {
  return text
    .toLowerCase()
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9$%]+/g, " ")
    .split(" ")
    .filter((w) => w && !QUESTION_STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ies|es|s|ing|ed)$/, "") : w));
}

/** Markdown-lite to a slug of its words: "**1. Open Billing**" is "1-open-billing". */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The words a passage opens with, as a slug: its bold lead, or its first words. */
function openingOf(entry) {
  return slugify(entry.l ? entry.l : entry.x.slice(0, 300));
}

/**
 * The shortest ref that names each passage of a page, for the question
 * lists and the bank: "in-plain-words", "<anchor>" when the heading has one
 * passage, or "<anchor>/<the words it opens with>" when it has several.
 */
export function refsFor(pageEntries) {
  const count = new Map();
  for (const e of pageEntries) count.set(e.a, (count.get(e.a) || 0) + 1);
  return pageEntries.map((e) => {
    if (e.ipw) return IPW_REF;
    const name = e.a === "" ? IPW_REF : e.a;
    if (count.get(e.a) === 1) return name;
    const mine = openingOf(e).split("-");
    const others = pageEntries.filter((o) => o !== e && o.a === e.a && !o.ipw).map(openingOf);
    let k = Math.min(mine.length, 3);
    const clash = (n) => others.some((o) => o === mine.slice(0, n).join("-") || o.startsWith(`${mine.slice(0, n).join("-")}-`));
    while (k < mine.length && clash(k)) k++;
    return `${name}/${mine.slice(0, k).join("-")}`;
  });
}

/**
 * Finds the passage a ref names among one page's passages. A heading with
 * several passages and no opening words picks the one that shares most words
 * with the question, leaning to the first. Returns a position, or { error }.
 */
export function resolveRef(pageEntries, ref, question, weight = () => 1) {
  const cut = ref.indexOf("/");
  const name = cut < 0 ? ref : ref.slice(0, cut);
  const opening = cut < 0 ? "" : ref.slice(cut + 1);
  const anchor = name === IPW_REF ? "" : name;
  const under = pageEntries.map((e, i) => [e, i]).filter(([e]) => e.a === anchor);
  if (!under.length) return { error: `#${name}, which is not a heading on that page` };
  if (name === IPW_REF && !opening) {
    const box = under.find(([e]) => e.ipw);
    return box ? box[1] : { error: "the In plain words box, which that page does not have" };
  }
  if (opening) {
    let hits = under.filter(([e]) => openingOf(e) === opening || openingOf(e).startsWith(`${opening}-`));
    if (!hits.length) hits = under.filter(([e]) => `-${slugify(e.x)}-`.includes(`-${opening}-`));
    if (!hits.length) return { error: `#${name}/${opening}, but nothing under that heading says "${opening.replace(/-/g, " ")}"` };
    return hits[0][1];
  }
  if (under.length === 1) return under[0][1];
  const asked = new Set(roughWords(question));
  let best = under[0][1];
  let bestScore = -1;
  under.forEach(([e, i], k) => {
    const has = new Set(roughWords(`${e.l || ""} ${e.x}`));
    let score = k === 0 ? 1.5 : 0;
    for (const w of asked) if (has.has(w)) score += weight(w);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * Cuts a passage to about `max` characters for the helper: a run of whole
 * paragraphs, list items and table rows that fits, cut at a sentence when a
 * single one is too long. With no questions it keeps the opening run; with
 * the questions tied to the passage (`asked`, their words) it keeps the run
 * that holds most of their words, so the answer stays in what is shown.
 * Returns { md, more } where more says something was left out.
 */
export function trimPassage(md, max = PASSAGE_SHOWN, asked = [], weight = () => 1) {
  if (md.length <= max) return { md, more: false };
  // A passage that holds a table is shown whole when it is not much longer:
  // a price table cut short reads as the wrong price.
  if (/^\|/m.test(md) && md.length <= Math.round(max * TABLE_ALLOWANCE)) return { md, more: false };
  const parts = md.split(/(\n+)/);
  const units = [];
  for (let i = 0; i < parts.length; i += 2) units.push({ text: parts[i], sep: i ? parts[i - 1] : "" });
  const cutAtSentence = (text) => {
    const head = text.slice(0, max);
    const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf(": "));
    return stop > max / 3 ? head.slice(0, stop + 1) : head.slice(0, head.lastIndexOf(" "));
  };
  const scoreOf = (text) => {
    const has = new Set(roughWords(text));
    let score = 0;
    for (const words of asked) for (const w of words) if (has.has(w)) score += weight(w);
    return score;
  };
  const isRow = (i) => i >= 0 && i < units.length && units[i].text.startsWith("|");
  let best = null;
  for (let a = 0; a < units.length; a++) {
    // Never start inside a table: a table shows whole from its first row, or
    // from its first row down as far as fits. Starting on a later row (with
    // the header stuck on top) dropped the rows between, which read as a
    // price table that began at "21 to 40".
    if (isRow(a) && isRow(a - 1)) continue;
    let text = units[a].text.length > max ? cutAtSentence(units[a].text) : units[a].text;
    if (text.length > max) continue;
    for (let b = a + 1; units[a].text.length <= max && b < units.length; b++) {
      const next = text + units[b].sep + units[b].text;
      if (next.length > max) break;
      text = next;
    }
    const score = scoreOf(text) + (a === 0 ? 0.5 : 0);
    if (!best || score > best.score) best = { score, text };
    if (!asked.length) break;
  }
  let out = best.text;
  // Don't end on a lead-in ("Four things to check:") or a step's title.
  const lines = out.split(/\n+/);
  while (lines.length > 1 && /(:|^\*\*[^*]+\*\*)$/.test(lines[lines.length - 1].trim())) {
    out = out.slice(0, out.lastIndexOf(lines.pop())).replace(/\n+$/, "");
  }
  return { md: out.trim(), more: true };
}

/**
 * The docs helper's index: one entry per passage of every section, every
 * question the pages and the bank answer, tied to the passage that answers
 * it, and the synonym groups. A question names its passage with a ref: in a
 * page's questions list as `{#ref}` after the words, in the bank as
 * "anchor", or in an "alt" page as "page#ref". A question whose words match
 * a heading or bold lead goes to that passage. Anything else points at its
 * page only.
 *
 * Returns { index, problems, stats }. The index is the in-memory shape the
 * matcher reads; `toWire` packs it for the browser.
 */
export function buildAskIndex(pages, sectionList, bank, synonyms, options = {}) {
  const shown = options.shown ?? PASSAGE_SHOWN;
  const pageIndex = new Map(pages.map((p, i) => [p.path, i]));
  const out = { version: 2, pages: [], entries: [], questions: [], synonyms };
  const full = [];
  const byPage = pages.map(() => []);
  const leadIndex = new Map();
  pages.forEach((p, pi) => {
    out.pages.push({ u: p.url, t: p.fm.title, k: p.fm.keywords.join(", ") });
    for (const section of p.extract.sections) {
      chunkBlocks(section.blocks).forEach((c, ci) => {
        const e = { p: pi, a: section.anchor, h: section.title, x: c.md };
        if (c.lead) e.l = c.lead;
        if (section.anchor === "" && ci === 0) e.ipw = 1;
        const idx = out.entries.push(e) - 1;
        full.push(c.md);
        byPage[pi].push(idx);
        if (ci === 0 && section.anchor !== "") leadIndex.set(`${pi}|${norm(section.title)}`, idx);
        if (c.lead) leadIndex.set(`${pi}|${norm(c.lead)}`, idx);
      });
    }
  });

  // Word weights over every passage, to pick among one heading's passages.
  const df = new Map();
  for (const x of full) for (const w of new Set(roughWords(x))) df.set(w, (df.get(w) || 0) + 1);
  const weight = (w) => Math.log(1 + full.length / (1 + (df.get(w) || 0)));

  const problems = [];
  const seen = new Map();
  const stats = { questions: 0, withPassage: 0, pageOnly: 0 };
  const resolve = (pi, ref, q) => {
    const list = byPage[pi].map((i) => ({ ...out.entries[i], x: full[i] }));
    const r = resolveRef(list, ref, q, weight);
    return typeof r === "number" ? { e: byPage[pi][r] } : r;
  };
  const addQuestion = (q, path, ref, where) => {
    const pi = pageIndex.get(path);
    if (pi === undefined) {
      problems.push(`${where}: "${q}" points at ${path}, which is not a page`);
      return;
    }
    let e = leadIndex.get(`${pi}|${norm(q)}`);
    if (ref !== null && ref !== undefined) {
      const r = resolve(pi, ref, q);
      if (r.error) {
        problems.push(`${where}: "${q}" points at ${path}${r.error.startsWith("#") ? "" : " "}${r.error}`);
        return;
      }
      e = r.e;
    }
    const key = `${norm(q)}|${pi}`;
    const had = seen.get(key);
    if (had) {
      // The same question from the page and the bank: one record, one passage.
      if (had.rec.e === undefined && e !== undefined) had.rec.e = e;
      else if (ref && had.ref && had.rec.e !== e) {
        problems.push(`${where}: "${q}" points at ${path}#${ref}, but ${had.where} points it at #${had.ref}`);
      }
      return;
    }
    const rec = { q, p: pi };
    if (e !== undefined) rec.e = e;
    seen.set(key, { rec, ref: ref ?? null, where });
    out.questions.push(rec);
  };
  pages.forEach((p) => p.asked.forEach((a) => addQuestion(a.text, p.path, a.ref, `content/docs/${p.file}`)));
  for (const item of bank) {
    addQuestion(item.q, item.page, item.anchor, "question bank");
    for (const alt of item.alt || []) {
      const [path, ref] = alt.split("#");
      addQuestion(item.q, path, ref, "question bank");
    }
  }
  for (const q of out.questions) {
    stats.questions++;
    if (q.e === undefined) stats.pageOnly++;
    else stats.withPassage++;
  }

  // What the helper shows: each passage cut to what a reader needs, keeping
  // the part that answers the questions tied to it.
  const askedOf = new Map();
  for (const q of out.questions) {
    if (q.e === undefined) continue;
    if (!askedOf.has(q.e)) askedOf.set(q.e, []);
    askedOf.get(q.e).push(roughWords(q.q));
  }
  let trimmed = 0;
  for (const [i, e] of out.entries.entries()) {
    // In plain words always reads from its start.
    const t = trimPassage(e.x, shown, e.ipw ? [] : (askedOf.get(i) ?? []), weight);
    if (t.more) {
      e.x = t.md;
      e.m = 1;
      trimmed++;
    }
  }
  stats.trimmed = trimmed;
  return { index: out, problems, stats };
}

/**
 * Packs the helper's index for the browser: sections listed once, each
 * passage as [section, text, lead?, more?], links to docs pages as @<page>,
 * questions as [words, page, passage?]. `expandIndex` in
 * lib/docs/ask/match.ts reverses it.
 */
export function toWire(index) {
  const pageOf = new Map(index.pages.map((p, i) => [p.u, i]));
  const link = (x) =>
    x.replace(/\]\((\/docs\/[^)#\s]+)(#[^)\s]*)?\)/g, (m, u, a) => (pageOf.has(u) ? `](@${pageOf.get(u)}${a ?? ""})` : m));
  const sections = [];
  const sectionOf = new Map();
  const entries = index.entries.map((e) => {
    const key = `${e.p}|${e.a}`;
    let s = sectionOf.get(key);
    if (s === undefined) {
      s = sections.push([e.p, e.a, e.h]) - 1;
      sectionOf.set(key, s);
    }
    const row = [s, link(e.x)];
    if (e.l || e.m) row.push(e.l ?? "");
    if (e.m) row.push(1);
    return row;
  });
  return {
    v: index.version,
    p: index.pages.map((p) => [p.u, p.t, p.k]),
    s: sections,
    e: entries,
    q: index.questions.map((q) => (q.e === undefined ? [q.q, q.p] : [q.q, q.p, q.e])),
    y: index.synonyms,
  };
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The matcher's eval fixture: EVAL_SIZE bank questions picked by a stable
 * hash, spread over the bank's sections, each with its home pages and the
 * passage on each that answers it (`e`, an entry of the index, and `at`,
 * the same as "url#anchor" for reading). The tests hold each one out of the
 * index before asking it. Without an index, passages are left out.
 */
export function buildEvalFixture(bank, index = null, size = EVAL_SIZE) {
  const bySection = new Map();
  for (const item of bank) {
    const k = item.bankSection ?? 0;
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k).push(item);
  }
  for (const list of bySection.values()) list.sort((a, b) => fnv(a.q) - fnv(b.q));
  const picked = [];
  const lists = [...bySection.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  for (let round = 0; picked.length < size; round++) {
    let any = false;
    for (const list of lists) {
      if (round < list.length && picked.length < size) {
        picked.push(list[round]);
        any = true;
      }
    }
    if (!any) break;
  }
  const homesOf = (item) => [item.page, ...(item.alt || []).map((a) => a.split("#")[0])];
  if (!index) return picked.map((item) => ({ q: item.q, pages: homesOf(item).map((p) => `/docs/${p}`) }));
  const pageOf = new Map(index.pages.map((p, i) => [p.u, i]));
  const intro = new Map();
  index.entries.forEach((e, i) => {
    if (e.ipw && !intro.has(e.p)) intro.set(e.p, i);
  });
  const record = new Map(index.questions.map((q) => [`${norm(q.q)}|${q.p}`, q]));
  return picked.map((item) => {
    const pages = homesOf(item).map((p) => `/docs/${p}`);
    const e = pages.map((u) => {
      const pi = pageOf.get(u);
      const rec = record.get(`${norm(item.q)}|${pi}`);
      return rec && rec.e !== undefined ? rec.e : intro.get(pi);
    });
    const at = e.map((i) => `${index.pages[index.entries[i].p].u}#${index.entries[i].a}`);
    return { q: item.q, pages, e, at };
  });
}

/** Every synonym group's first word (the docs' own word) must appear in the pages. */
export function checkSynonyms(synonyms, corpus) {
  const text = ` ${corpus.toLowerCase().replace(/[^a-z0-9%$]+/g, " ")} `;
  const problems = [];
  synonyms.forEach((group, i) => {
    if (!Array.isArray(group) || group.length < 2) {
      problems.push(`synonym group ${i + 1} needs the docs' word and at least one other`);
      return;
    }
    const word = ` ${group[0].toLowerCase().replace(/[^a-z0-9%$]+/g, " ").trim()} `;
    if (!text.includes(word)) problems.push(`synonym group ${i + 1}: "${group[0]}" appears nowhere in the docs`);
  });
  return problems;
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}
