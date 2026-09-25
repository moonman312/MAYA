// The docs helper's set replies and what it says to a question, on the real index.
// Run with: npm test
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandIndex } from "./match.ts";
import { createIntents, oneEditApart, INTENT_MATCH } from "./intents.ts";
import { createHelper, placeFor } from "./respond.ts";
import { createSpeller, editDistance } from "./normalize.ts";

vi.setConfig({ testTimeout: 120_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/ask-manifest.json"), "utf8"));
const index = expandIndex(JSON.parse(fs.readFileSync(path.join(ROOT, "public", manifest.file), "utf8")));
const pagesMeta = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/pages.json"), "utf8"));
const helper = createHelper(index);
const pageOf = (u) => index.pages.findIndex((p) => p.u === u);
const at = (u) => ({ place: placeFor(index, u) });
const say = (q, ctx) => helper.respond(q, ctx);

test("the index carries the set replies, and every link in them reaches a docs page and heading", () => {
  const r = index.replies;
  assert.ok(r, "the build packs content/docs-helper-replies.json into the index");
  const ids = new Map(pagesMeta.map((p) => [p.url, new Set(p.headings.map((h) => h.id))]));
  const check = (href, where) => {
    const [u, a] = href.split("#");
    assert.ok(ids.has(u), `${where}: ${href} is not a docs page`);
    if (a) assert.ok(ids.get(u).has(a), `${where}: ${href} is not a heading on that page`);
  };
  for (const l of r.start) check(l.href, "start");
  for (const it of r.intents) {
    for (const l of it.links ?? []) check(l.href, it.id);
    for (const m of (it.say ?? "").matchAll(/\]\(([^)\s]+)\)/g)) {
      if (m[1].startsWith("mailto:")) continue;
      check(m[1], `${it.id} text`);
    }
    if (it.show !== undefined) assert.ok(index.entries[it.show], `${it.id}: shows a passage`);
  }
  for (const [id, a] of Object.entries(r.areas)) assert.ok(a.page === null || index.pages[a.page], id);
});

test("set replies are written the way the docs are: no long dashes, MAYA never learns, knows or thinks", () => {
  for (const it of index.replies.intents) {
    const text = `${it.say ?? ""} ${it.linksTitle ?? ""}`;
    assert.doesNotMatch(text, /[–—]/, `${it.id}: long dash`);
    assert.doesNotMatch(text, /\bMAYA (learns|knows|thinks)\b/i, it.id);
  }
});

test("general questions get their set reply", () => {
  for (const [q, id] of [
    ["hi", "greeting"],
    ["Hello there!", "greeting"],
    ["thanks!", "thanks"],
    ["thx", "thanks"],
    ["bye", "bye"],
    ["help", "help"],
    ["?", "help"],
    ["how do I use this?", "page"],
    ["how does this thing work?", "page"],
    ["how dose this work", "page"],
    ["what is this", "page"],
    ["explain this page", "page"],
    ["tell me about MAYA", "overview"],
    ["what is maya", "overview"],
    ["where do I start", "start"],
    ["i'm lost", "lost"],
    ["I'm confused", "lost"],
    ["what can you do", "capabilities"],
    ["what can I ask?", "capabilities"],
    ["are you a bot", "bot"],
    ["are you AI?", "bot"],
    ["can I talk to a person", "human"],
    ["i need a human", "human"],
    ["this is useless", "frustrated"],
    ["wrong answer", "missed"],
    ["ok", "ack"],
  ]) {
    const r = say(q);
    assert.equal(r.outcome, "canned", `${q}: ${r.outcome}`);
    assert.equal(r.canned.intent, id, q);
  }
});

test("a question with a subject of its own is answered from the docs, never with a set reply", () => {
  for (const [q, url] of [
    ["how does booking speed work", "/docs/rules/booking-speed"],
    ["how do I use the rate simulator", null],
    ["help with billing", null],
    ["hi, how much does MAYA cost?", "/docs/start/what-it-costs"],
    ["Is MAYA AI?", "/docs/start/what-maya-does"],
    ["thanks, and what about Mews?", "/docs/connect/mews"],
    ["I'm confused about sellable occupancy", null],
    ["how does the calendar work", "/docs/watch/the-calendar"],
    ["what can MAYA not do yet?", "/docs/reference/what-maya-does-not-do"],
  ]) {
    const r = say(q);
    assert.notEqual(r.outcome, "canned", `${q}: ${r.canned?.intent}`);
    assert.notEqual(r.outcome, "none", q);
    if (url) assert.equal(index.pages[r.docs.answer.page].u, url, q);
  }
});

test("a message pasted in quotes always goes to the docs", () => {
  assert.notEqual(say('"MAYA couldn\'t tell why"').outcome, "canned");
});

test("of every question the docs and the bank list, only a few general ones get a set reply, and each one fits", () => {
  // The whole list, so a new example that starts taking topic questions fails here.
  const allowed = new Map([
    ["What does MAYA actually do?", "overview"],
    ["What MAYA does", "overview"],
    ["How do I get started with MAYA?", "start"],
    ["How to get started", "start"],
    ["what happens when i sign up", "start"],
    ["How do I contact support?", "human"],
    ["Contact support", "human"],
    ["What is the docs helper?", "bot"],
  ]);
  const asked = new Set([...index.questions.map((q) => q.q), ...index.pages.map((p) => p.t)]);
  const got = [];
  for (const q of asked) {
    const r = say(q);
    if (r.outcome === "canned") got.push(`${q} -> ${r.canned.intent}`);
  }
  assert.deepEqual(got.sort(), [...allowed].map(([q, id]) => `${q} -> ${id}`).sort());
});

test("this, here and it answer about the page the reader is on", () => {
  const page = "/docs/rules/booking-window";
  const r = say("how does this work?", at(page));
  assert.equal(r.canned.intent, "page");
  assert.equal(index.pages[r.canned.show.page].u, page);
  assert.equal(r.canned.show.entry, helper.matcher.introFor(pageOf(page)), "the page's In plain words");
  assert.match(r.canned.say, /Booking window/);
  assert.ok(r.canned.links.length >= 2, "its headings");
  for (const l of r.canned.links) assert.ok(l.href.startsWith(`${page}#`), l.href);
  assert.equal(r.canned.linksTitle, "On this page");
  // The outline is the page's H2 headings, in order.
  const h2 = pagesMeta.find((p) => p.url === page).headings.filter((h) => h.depth === 2).map((h) => h.id);
  assert.deepEqual(r.canned.links.map((l) => l.href.split("#")[1]), h2.slice(0, r.canned.links.length));
});

test("on the docs home, the support page or anywhere without a page, this means MAYA and its docs", () => {
  for (const where of ["/docs", "/support"]) {
    const r = say("what is this?", at(where));
    assert.equal(r.canned.intent, "page");
    assert.equal(index.pages[r.canned.show.page].u, "/docs/start/what-maya-does");
    assert.ok(r.canned.links.some((l) => l.href === "/docs/start/how-to-get-started"));
  }
  const site = say("what is this website", at("/docs/rules/booking-speed"));
  assert.equal(index.pages[site.canned.show.page].u, "/docs/start/what-maya-does", "the site, not the page");
});

test("it after an answer means that answer's page; this page means the one the reader is on", () => {
  const first = say("what is booking speed", at("/docs"));
  const lastPage = first.docs.answer.page;
  assert.equal(index.pages[lastPage].u, "/docs/rules/booking-speed");
  const ctx = { ...at("/docs/watch/the-calendar"), lastPage, lastQuestion: "what is booking speed" };
  const it = say("how does it work?", ctx);
  assert.equal(it.canned.intent, "page");
  assert.equal(index.pages[it.canned.show.page].u, "/docs/rules/booking-speed");
  assert.equal(it.canned.linksTitle, "On that page");
  const here = say("what is this page about", ctx);
  assert.equal(index.pages[here.canned.show.page].u, "/docs/watch/the-calendar");
});

test("opened from MAYA's Help, the page reply says which screen it came from", () => {
  const r = say("how do I use this", { ...at("/docs/watch/the-calendar"), appArea: "calendar" });
  assert.match(r.canned.say, /^You opened Help from the Calendar tab in MAYA\./);
  const elsewhere = say("how do I use this", { ...at("/docs/rules/booking-speed"), appArea: "calendar" });
  assert.doesNotMatch(elsewhere.canned.say, /opened Help/, "only on the page that screen opens");
});

test("no answer keeps the outcome none and offers somewhere to go", () => {
  const r = say("purple elephant dancing");
  assert.equal(r.outcome, "none");
  assert.equal(r.canned, null);
  assert.ok(r.start.length >= 3, "good places to start");
  for (const l of r.start) assert.ok(pageOf(l.href) >= 0, l.href);
  assert.equal(say("How do I bake sourdough bread?").outcome, "none");
});

test("where a question was asked from", () => {
  assert.deepEqual(placeFor(index, "/docs"), { page: null, section: "home" });
  assert.deepEqual(placeFor(index, "/docs/"), { page: null, section: "home" });
  assert.deepEqual(placeFor(index, "/support"), { page: null, section: "support" });
  assert.deepEqual(placeFor(index, "/docs/rules/booking-speed"), { page: pageOf("/docs/rules/booking-speed"), section: "rules" });
  assert.deepEqual(placeFor(index, "/docs/rules/no-such-page"), { page: null, section: "rules" });
});

test("the intents fix casual spelling, squeeze repeated letters and allow one typo only in words the docs never use", () => {
  const i = createIntents(index.replies, helper.matcher.knows);
  const words = (q) => i.words(q).map((w) => w.raw).join(" ");
  assert.equal(words("hw dose this work"), "how does this work");
  assert.equal(words("helpp"), "help");
  assert.equal(words("hellooo"), "hello");
  assert.equal(words("idk"), "i do not know");
  assert.equal(words("code"), "code", "a docs word is never read as a typo");
  assert.ok(oneEditApart("helo", "hello") && oneEditApart("thnaks", "thanks") && !oneEditApart("code", "cold1"));
  assert.ok(INTENT_MATCH > 0.5 && INTENT_MATCH < 1);
  const m = i.match("hi there, xyzzy");
  assert.equal(m.intent.id, "greeting");
  assert.deepEqual(m.residual, ["xyzzi"], "the unknown word is the question's own subject");
});

test("the matcher reads a misspelt docs word as the word", () => {
  assert.equal(editDistance("calender", "calendar", 1), 1);
  assert.equal(editDistance("simluation", "simulation", 2), 1, "two letters swapped is one edit");
  assert.equal(editDistance("cook", "book", 0), 1);
  const spell = createSpeller(new Map([["booking", 40], ["calendar", 12], ["cancel", 9], ["book", 50]]));
  assert.equal(spell("boking calender cancle"), "booking calendar cancel");
  assert.equal(spell("cook rice"), "cook rice", "short words and other first letters stay");
  for (const [q, url] of [
    ["boking speed", "/docs/rules/booking-speed"],
    ["calender", "/docs/watch/the-calendar"],
    ["simluation mode", "/docs/live/simulation-mode"],
  ]) {
    const r = helper.matcher.ask(q);
    assert.notEqual(r.confidence, "none", q);
    assert.equal(index.pages[r.answer.page].u, url, q);
  }
});
