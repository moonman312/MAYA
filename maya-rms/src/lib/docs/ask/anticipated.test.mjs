// The docs helper against the questions people really type: vague, casual,
// misspelt, one word, in shaky English, from prospects, and small talk
// (lib/docs/ask/anticipated.json). Each question lists what a right reply
// is: a docs page ("rules/booking-speed"), a set reply ("intent:help"), or
// "none" for a question the docs should not answer. A question may name the
// page it is asked on ("on") and a question asked before it ("after").
//
// The question banks and the set replies were tuned with this set in view,
// so the numbers that matter most are for the questions no bank or set reply
// lists word for word ("unlisted"). Questions marked "late" were written
// after the rest, and measured once before anything was changed for them.
// A reply counts as right when it is confident and lands on a wanted page or
// set reply; "unsure" is "This might help"; none is no answer.
// Run with: npm test
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandIndex } from "./match.ts";
import { clean } from "./normalize.ts";
import { createHelper, placeFor } from "./respond.ts";

vi.setConfig({ testTimeout: 120_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/ask-manifest.json"), "utf8"));
const index = expandIndex(JSON.parse(fs.readFileSync(path.join(ROOT, "public", manifest.file), "utf8")));
const set = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/ask/anticipated.json"), "utf8"));
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
/** Every question a bank or set reply lists word for word. */
const listed = new Set(
  [
    ...read("content/docs-questions.json").map((b) => b.q),
    ...read("content/docs-questions-everyday.json").map((b) => b.q),
    ...index.replies.intents.flatMap((i) => i.examples),
  ].map(clean),
);

/** One question's reply, judged: right, unsure-right, unsure-wrong, wrong or none. */
function judge(helper, it) {
  const place = placeFor(index, it.on ?? "/docs");
  let ctx = { place };
  if (it.after) {
    const a = helper.respond(it.after, ctx);
    ctx = { ...ctx, lastPage: a.outcome === "none" ? null : (a.canned?.show?.page ?? a.docs.answer?.page ?? null), lastQuestion: it.after };
  }
  const r = helper.respond(it.q, ctx);
  const wants = new Set(it.want);
  const onPage = it.on?.startsWith("/docs/") ? it.on.slice(6) : null;
  const short = (p) => index.pages[p].u.slice(6);
  if (r.outcome === "none") return { verdict: wants.has("none") ? "right" : "none", got: "none" };
  if (wants.has("none")) return { verdict: "wrong", got: r.outcome };
  if (r.outcome === "canned") {
    const c = r.canned;
    const shown = c.show ? short(c.show.page) : null;
    const got = `intent:${c.intent}${shown ? ` ${shown}` : ""}`;
    if (c.intent === "page") {
      // About the page asked on, the page of the question before, or (with no page) MAYA itself.
      const fits = !shown || shown === onPage || wants.has(shown) || (!onPage && shown === "start/what-maya-does");
      return { verdict: (wants.has("intent:page") && fits) || (shown && wants.has(shown)) ? "right" : "wrong", got };
    }
    return { verdict: wants.has(`intent:${c.intent}`) || (shown && wants.has(shown)) ? "right" : "wrong", got };
  }
  const url = short(r.docs.answer.page);
  const right = wants.has(url) || (wants.has("intent:page") && url === onPage);
  if (r.outcome === "unsure") return { verdict: right ? "unsure-right" : "unsure-wrong", got: url };
  return { verdict: right ? "right" : "wrong", got: url };
}

test("the anticipated questions are well formed and point at real pages", () => {
  assert.ok(set.length >= 950, `${set.length} questions`);
  const pages = new Set(index.pages.map((p) => p.u.slice(6)));
  const intents = new Set(index.replies.intents.map((i) => `intent:${i.id}`));
  for (const it of set) {
    assert.ok(typeof it.q === "string" && Array.isArray(it.want) && it.want.length, JSON.stringify(it));
    for (const w of it.want) assert.ok(w === "none" || pages.has(w) || intents.has(w), `${it.q}: ${w}`);
    if (it.on) assert.ok(it.on === "/docs" || it.on === "/support" || pages.has(it.on.slice(6)), it.on);
  }
  const unlisted = set.filter((it) => !listed.has(clean(it.q))).length;
  assert.ok(unlisted >= set.length / 3, `${unlisted} unlisted questions`);
  assert.ok(set.filter((it) => it.late).length >= 150, "late questions");
});

test("the anticipated questions: mostly right, rarely wrong, almost never no answer", () => {
  const helper = createHelper(index);
  const count = { all: {}, unlisted: {}, late: {} };
  const misses = [];
  for (const it of set) {
    const { verdict, got } = judge(helper, it);
    const groups = ["all"];
    if (!listed.has(clean(it.q))) groups.push("unlisted");
    if (it.late) groups.push("late");
    for (const k of groups) count[k][verdict] = (count[k][verdict] ?? 0) + 1;
    if (verdict !== "right") misses.push(`${verdict}\t${it.q}${it.on ? ` (on ${it.on})` : ""}\t${got}\twant ${it.want.join("|")}`);
  }
  const share = (k, v) => {
    const n = Object.values(count[k]).reduce((a, b) => a + b, 0);
    return (count[k][v] ?? 0) / n;
  };
  const line = (k) =>
    ["right", "unsure-right", "unsure-wrong", "wrong", "none"].map((v) => `${v} ${(100 * share(k, v)).toFixed(1)}%`).join(", ");
  for (const k of ["all", "unlisted", "late"]) console.log(`anticipated questions, ${k}: ${line(k)}`);
  const why = misses.join("\n");
  assert.ok(share("all", "right") >= 0.87, `right ${share("all", "right")}\n${why}`);
  assert.ok(share("unlisted", "right") >= 0.8, `unlisted right ${share("unlisted", "right")}\n${why}`);
  assert.ok(share("all", "wrong") <= 0.075, `wrong ${share("all", "wrong")}\n${why}`);
  assert.ok(share("all", "none") <= 0.015, `none ${share("all", "none")}\n${why}`);
});
