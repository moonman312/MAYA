// The docs helper's matcher, on a tiny index and on the real one.
// Run with: npm test
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMatcher, expandIndex, isFollowUp } from "./match.ts";
import { buildSynonymTable, clean, tokenize, trigrams } from "./normalize.ts";
import { stem } from "./porter.ts";

// Whole-corpus checks: slower than a unit test, and slower still when the suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("the stemmer brings word forms together", () => {
  for (const [a, b] of [
    ["raises", "raised"],
    ["raising", "raise"],
    ["bookings", "booking"],
    ["cancelled", "canceled"],
    ["connection", "connected"],
  ]) {
    assert.equal(stem(a), stem(b), `${a} / ${b}`);
  }
  assert.equal(stem("is"), "is");
});

test("normalising drops punctuation and stop words, keeps numbers, prices and system names", () => {
  assert.equal(clean("Why is my price $1?!"), "why is my price $1");
  assert.equal(clean("What does “12/20 rooms” mean?"), "what does 12of20 rooms mean");
  const t = tokenize("Why did MAYA raise my Cloudbeds price to $300 on Friday?");
  for (const want of ["maya", stem("raise"), stem("cloudbeds"), "price", "$300", stem("friday")]) assert.ok(t.includes(want), `${want} in ${t}`);
  for (const gone of ["why", "did", "my", "to", "on"]) assert.ok(!t.includes(gone), `${gone} dropped`);
});

test("synonyms add a shared token, phrases included, next to the reader's own words", () => {
  const syn = buildSynonymTable([
    ["price", "rate", "adr"],
    ["full", "sold out"],
  ]);
  const a = tokenize("What rate?", syn);
  const b = tokenize("the price", syn);
  assert.ok(a.includes("syn0") && b.includes("syn0"));
  assert.ok(a.includes("rate"), "the reader's own word stays");
  assert.ok(tokenize("we are sold out tonight", syn).includes("syn1"));
  assert.ok(trigrams(["book", "speed"]).has("spe"));
});

// ── A tiny index ─────────────────────────────────────────────────────

const tiny = {
  version: 1,
  pages: [
    { u: "/docs/recipes/reset-your-password", t: "Reset your password", s: "How do I...", k: "password, forgot, reset, login" },
    { u: "/docs/rules/booking-speed", t: "Booking speed", s: "Rules", k: "pace, faster than normal, wedding" },
    { u: "/docs/connect/mews", t: "Mews: what works today", s: "Your property system", k: "mews, reads only" },
  ],
  entries: [
    { p: 0, a: "", h: "In plain words", x: "There is no password reset link yet. Email us and we send you a link.", ipw: 1 },
    { p: 1, a: "", h: "In plain words", x: "Booking speed compares a night's recent bookings with similar past nights.", ipw: 1 },
    { p: 1, a: "a-wedding", h: "A wedding counts once", x: "A booking with several rooms counts once for booking speed." },
    { p: 2, a: "", h: "In plain words", x: "MAYA reads Mews bookings and shows prices. Nothing is sent to Mews.", ipw: 1 },
    { p: 2, a: "typed-prices", h: "Typed prices on Mews", x: "A price you type on a Mews property is shown but not sent." },
  ],
  questions: [
    { q: "I forgot my password, what do I do?", p: 0 },
    { q: "Does a wedding count as lots of bookings?", p: 1, e: 2 },
    { q: "Does MAYA send prices to Mews?", p: 2, b: 1 },
  ],
  synonyms: [["password", "login details"]],
};

test("a close match to a page's own question answers with that page", () => {
  const m = createMatcher(tiny);
  const r = m.ask("forgot my password");
  assert.equal(r.confidence, "high");
  assert.equal(r.answer.page, 0);
  assert.equal(r.answer.entry, 0, "the In plain words passage");
});

test("a question tied to a section answers with that section's passage", () => {
  const r = createMatcher(tiny).ask("does a wedding count as lots of bookings");
  assert.equal(r.answer.page, 1);
  assert.equal(r.answer.entry, 2);
});

test("nonsense gets the not-covered answer and nothing else", () => {
  const r = createMatcher(tiny).ask("purple elephant dancing");
  assert.equal(r.confidence, "none");
  assert.equal(r.answer, null);
  assert.deepEqual(r.alsoSee, []);
  assert.equal(createMatcher(tiny).ask("   ").confidence, "none");
});

test("a short follow-up stays on the last answer's topic", () => {
  const m = createMatcher(tiny);
  assert.ok(isFollowUp("what about Mews?"));
  assert.ok(!isFollowUp("How do I undo a price change on a Saturday night?"));
  const first = m.ask("Does a wedding count as lots of bookings?");
  const follow = m.ask("and typed prices?", { lastPage: first.answer.page, lastQuestion: "Does a wedding count as lots of bookings?" });
  assert.ok(follow.pages.length > 0);
});

test("excluded questions are held out of the bank", () => {
  const m = createMatcher(tiny, { exclude: (q) => q.p === 0 });
  const r = m.ask("I forgot my password, what do I do?");
  assert.ok(r.score < 1, "no exact bank match once held out");
});

// ── The real index and the held-out eval ─────────────────────────────

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/ask-manifest.json"), "utf8"));
const index = expandIndex(JSON.parse(fs.readFileSync(path.join(ROOT, "public", manifest.file), "utf8")));
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/ask-eval.json"), "utf8"));
const pct = (n) => `${((100 * n) / fixture.length).toFixed(1)}%`;

test("the eval fixture holds 150 bank questions, each with its home pages and the passage on each that answers it", () => {
  assert.equal(fixture.length, 150);
  const urls = new Set(index.pages.map((p) => p.u));
  for (const f of fixture) {
    assert.ok(f.pages.length >= 1);
    assert.equal(f.e.length, f.pages.length, f.q);
    f.pages.forEach((u, i) => {
      assert.ok(urls.has(u), u);
      assert.equal(index.pages[index.entries[f.e[i]].p].u, u, `${f.q}: its passage is on its page`);
    });
  }
});

// Held out: each fixture question (and any page question with the same
// words) is removed from the index before it is asked. A question counts as
// right only on its own home pages and the passages that answer it there,
// as the bank records them. No page is added as a home after looking at
// what the matcher answered: that lenient view is the separate check below.
function heldOutRun() {
  const held = new Set(fixture.map((f) => clean(f.q)));
  const m = createMatcher(index, { exclude: (q) => held.has(clean(q.q)) });
  return fixture.map((f) => ({ f, top: m.ask(f.q).pages.slice(0, 3) }));
}

test("held-out bank questions, page: top-1 at least 70%, top-3 at least 93%", () => {
  let top1 = 0;
  let top3 = 0;
  const misses = [];
  for (const { f, top } of heldOutRun()) {
    const urls = top.map((h) => index.pages[h.page].u);
    if (f.pages.includes(urls[0])) top1++;
    else misses.push(`${f.q} -> ${urls[0]}`);
    if (urls.some((u) => f.pages.includes(u))) top3++;
  }
  console.log(`matcher eval, page: top-1 ${pct(top1)}, top-3 ${pct(top3)} on ${fixture.length} held-out questions`);
  assert.ok(top1 / fixture.length >= 0.7, `top-1 ${pct(top1)}\n${misses.join("\n")}`);
  assert.ok(top3 / fixture.length >= 0.93, `top-3 ${pct(top3)}`);
});

test("held-out bank questions, the passage that answers them: top-1 at least 50%, top-3 at least 60%", () => {
  let top1 = 0;
  let top3 = 0;
  let section1 = 0;
  const sectionOf = (e) => `${index.entries[e].p}|${index.entries[e].a}`;
  for (const { f, top } of heldOutRun()) {
    const want = new Set(f.e);
    const sections = new Set(f.e.map(sectionOf));
    if (top[0] && want.has(top[0].entry)) top1++;
    if (top.some((h) => want.has(h.entry))) top3++;
    if (top[0] && sections.has(sectionOf(top[0].entry))) section1++;
  }
  console.log(
    `matcher eval, passage: top-1 ${pct(top1)}, top-3 ${pct(top3)} (same section as the answer, top-1: ${pct(section1)})`,
  );
  assert.ok(top1 / fixture.length >= 0.5, `passage top-1 ${pct(top1)}`);
  assert.ok(top3 / fixture.length >= 0.6, `passage top-3 ${pct(top3)}`);
});

test("hand-judged extra homes (a lenient view, not the bar): page top-1 when a page someone checked by hand also counts", () => {
  // lib/docs/ask/judged-homes.json lists pages a person read and judged to
  // answer a held-out question directly, after seeing where the matcher went.
  // They were chosen for the eval's own questions, so they flatter it: the
  // numbers above leave them out, and this check only reports the gap.
  const judged = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/ask/judged-homes.json"), "utf8"));
  const urls = new Set(index.pages.map((p) => p.u));
  const extra = new Map();
  for (const j of judged) {
    assert.ok(urls.has(`/docs/${j.page}`), j.page);
    assert.ok(j.why, `${j.q}: why the page answers it`);
    extra.set(clean(j.q), [...(extra.get(clean(j.q)) ?? []), `/docs/${j.page}`]);
  }
  let honest = 0;
  let lenient = 0;
  for (const { f, top } of heldOutRun()) {
    const url = top[0] ? index.pages[top[0].page].u : null;
    if (f.pages.includes(url)) honest++;
    if (f.pages.includes(url) || (extra.get(clean(f.q)) ?? []).includes(url)) lenient++;
  }
  console.log(`matcher eval, lenient (hand-judged homes count): page top-1 ${pct(lenient)}, against ${pct(honest)} honest`);
  assert.ok(lenient >= honest);
});

test("with the bank in place, every bank question answers with one of its own pages and, mostly, its passage", () => {
  // Not an eval: a check that the bank and its passages reach the matcher.
  // A page whose own list has the same words counts too, since in the index
  // the two are one question.
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "content/docs-questions.json"), "utf8"));
  const records = new Map();
  for (const q of index.questions) records.set(clean(q.q), [...(records.get(clean(q.q)) ?? []), q]);
  const m = createMatcher(index);
  let right = 0;
  let passage = 0;
  for (const item of bank) {
    const r = m.ask(item.q);
    const homes = new Set([item.page, ...(item.alt || []).map((a) => a.split("#")[0])].map((p) => `/docs/${p}`));
    const same = records.get(clean(item.q)) ?? [];
    for (const q of same) homes.add(index.pages[q.p].u);
    if (!r.pages[0] || !homes.has(index.pages[r.pages[0].page].u)) continue;
    right++;
    const rec = same.find((q) => q.p === r.pages[0].page);
    if (r.pages[0].entry === (rec?.e ?? m.introFor(r.pages[0].page))) passage++;
  }
  console.log(`with the bank in place: page ${right} of ${bank.length}, its passage ${passage}`);
  assert.ok(right / bank.length >= 0.97, `${right} of ${bank.length}`);
  assert.ok(passage / bank.length >= 0.95, `passage ${passage} of ${bank.length}`);
});

test("real questions from the docs pages land where the pages say", () => {
  const m = createMatcher(index);
  const at = (q) => {
    const r = m.ask(q);
    return { url: index.pages[r.answer.page].u, entry: index.entries[r.answer.entry], r };
  };
  const pw = at("forgot my password");
  assert.equal(pw.url, "/docs/recipes/reset-your-password");
  assert.equal(pw.entry.ipw, 1, "the In plain words box, word for word");
  assert.equal(at("Is there a status page?").r.confidence, "high");
  assert.equal(at("how do I undo a price change").url, "/docs/recipes/undo-a-price-change");
  assert.equal(at("Why is my price $1?").url, "/docs/wrong/a-price-looks-wrong");
});

test("questions people ask before signing up land on the passage that answers them", () => {
  const m = createMatcher(index);
  for (const [q, url, anchor] of [
    ["Is MAYA AI?", "/docs/start/what-maya-does", "maya-counts-and-compares"],
    ["does MAYA learn from my data", "/docs/start/what-maya-does", "maya-counts-and-compares"],
    ["do you forecast occupancy", "/docs/start/what-maya-does", "no-forecasts"],
    ["will prices go crazy", "/docs/start/what-maya-does", "what-keeps-prices-in-check"],
    ["Can I get a refund?", "/docs/start/what-it-costs", "refunds"],
  ]) {
    const r = m.ask(q);
    assert.equal(r.confidence, "high", `${q}: ${r.confidence} ${r.score}`);
    assert.equal(index.pages[r.answer.page].u, url, q);
    assert.equal(index.entries[r.answer.entry].a, anchor, q);
  }
});

test("a short question the docs answer outright is not read as a follow-up", () => {
  const m = createMatcher(index);
  const first = "How do I undo a price change?";
  const r = m.ask("Is MAYA AI?", { lastPage: m.ask(first).answer.page, lastQuestion: first });
  assert.equal(index.entries[r.answer.entry].a, "maya-counts-and-compares");
});

test("off-topic questions are not answered with confidence", () => {
  const m = createMatcher(index);
  for (const q of ["purple elephant dancing", "How do I bake sourdough bread?", "asdfgh qwerty", "Who won the world cup in 2022?"]) {
    const r = m.ask(q);
    assert.equal(r.confidence, "none", `${q}: ${r.confidence} ${r.score}`);
  }
});

test("a follow-up about Mews stays on the page of the last answer", () => {
  const m = createMatcher(index);
  const first = m.ask("How do I undo a price change?");
  const follow = m.ask("what about for Mews?", { lastPage: first.answer.page, lastQuestion: "How do I undo a price change?" });
  assert.equal(index.pages[follow.answer.page].u, index.pages[first.answer.page].u);
});

test("the matcher builds and answers quickly enough for a browser", () => {
  const t0 = performance.now();
  const m = createMatcher(index);
  const built = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) m.ask("Why did my rule not fire on Saturday?");
  const each = (performance.now() - t1) / 20;
  assert.ok(built < 3000, `built in ${built.toFixed(0)} ms`);
  assert.ok(each < 100, `${each.toFixed(1)} ms a question`);
});

test("a short question after an unrelated one keeps its own answer, and borrowing is never confident", () => {
  const m = createMatcher(index);
  const first = "How do I undo a price change?";
  const ctx = { lastPage: m.ask(first).answer.page, lastQuestion: first };
  for (const q of ["is it AI", "any refunds?", "is there forecasting?", "does it learn?", "how much?"]) {
    const alone = m.ask(q);
    const after = m.ask(q, ctx);
    if (alone.confidence === "high") {
      assert.equal(after.answer?.entry, alone.answer.entry, `${q}: asked after "${first}" it should keep its own answer`);
    } else {
      assert.notEqual(after.confidence, "high", `${q}: an answer that borrowed its topic is at most unsure`);
    }
  }
});
