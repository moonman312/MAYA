// Links into MAYA from the docs: the linker, its dictionary, and the build's
// checks on every link a page writes. Run with: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPage, parseMdx } from "./extract.mjs";
import { loadPages } from "./build-lib.mjs";
import { createAppLinker, entryFor } from "../../src/lib/docs/app-linker.mjs";
import { createLinks } from "../../src/lib/deep-links/core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/app-labels.json"), "utf8"));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/deep-links/registry.json"), "utf8"));
const links = createLinks(registry);
const sections = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/sections.json"), "utf8"));
const pagesMeta = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/pages.json"), "utf8"));

const attrsOf = (node) => Object.fromEntries((node.attributes || []).map((a) => [a.name, a.value]));

function link(body, page = "rules/booking-speed") {
  const tree = parseMdx(body);
  createAppLinker(dict)({ page })(tree);
  const found = [];
  (function visit(n, trail) {
    if ((n.type === "mdxJsxTextElement" || n.type === "mdxJsxFlowElement") && (n.name === "Ui" || n.name === "AppLink")) {
      const a = attrsOf(n);
      const text = (function t(x) {
        return x.type === "text" ? x.value : (x.children || []).map(t).join("");
      })(n);
      found.push({ name: n.name, text, to: a.to, q: a.q, in: trail });
    }
    (n.children || []).forEach((c) => visit(c, [...trail, n.type]));
  })(tree, []);
  return found;
}

test("a place named in a sentence links; a field, a heading, a link and code do not", () => {
  const out = link(
    [
      "## The <Ui>Rules</Ui> tab",
      "",
      "Open the <Ui>Rules</Ui> tab and click <Ui>+ Add a rule</Ui>. Type a <Ui>Rule name</Ui>, then click <Ui>Add Rule</Ui>.",
      "",
      "See [the <Ui>Change Log</Ui>](/docs/watch/the-change-log) and `the change log`.",
    ].join("\n"),
  );
  const byText = (t, i = 0) => out.filter((x) => x.text === t)[i];
  assert.equal(byText("Rules", 0).to, undefined, "never in a heading");
  assert.equal(byText("Rules", 1).to, "rules.list");
  assert.equal(byText("+ Add a rule").to, "rules.new");
  assert.equal(byText("Rule name").to, undefined, "a field is never linked");
  assert.equal(byText("Add Rule").to, undefined, "an action is never linked");
  assert.equal(byText("Change Log").to, undefined, "never inside a link");
  assert.ok(!out.some((x) => x.name === "AppLink" && x.text === "the change log"), "never in code");
});

test("listed phrases in plain text link, whole words only, and not inside a <Ui>", () => {
  const out = link("Every change is in the change log. The change logs and exchange log stay words. Read the <Ui>change log</Ui> tab.");
  const phrases = out.filter((x) => x.name === "AppLink");
  assert.deepEqual(phrases.map((p) => [p.text, p.to]), [["change log", "changelog"]]);
});

test("a phrase's leading \"the\" stays outside the link, and a null phrase shields a longer one", () => {
  const out = link("Open the calendar. The review screen asks, and the calendar date stays words.\n\nThe dashboard shows it.");
  assert.deepEqual(
    out.filter((x) => x.name === "AppLink").map((x) => [x.text, x.to]),
    [
      ["calendar", "calendar"],
      ["review screen", "review"],
      ["dashboard", "home"],
    ],
  );
});

test("a label set by hand for its other place wins over the dictionary", () => {
  const out = link('Under <Ui to="rules.new" q="focus=conditions">Conditions</Ui>, one row. The <Ui>Conditions</Ui> column lists it.');
  assert.deepEqual(
    out.map((x) => [x.text, x.to ?? null, x.q ?? null]),
    [
      ["Conditions", "rules.new", "focus=conditions"],
      ["Conditions", "rules.list", null],
    ],
  );
});

test("one link per place per paragraph, and a pre-selected view counts as its own place", () => {
  const out = link("Open <Ui>Rules</Ui>, then <Ui>Rules</Ui> again, then <Ui>Enabled</Ui>.\n\nA new paragraph: <Ui>Rules</Ui>.");
  assert.deepEqual(
    out.map((x) => [x.text, x.to ?? null, x.q ?? null]),
    [
      ["Rules", "rules.list", null],
      ["Rules", null, null],
      ["Enabled", "rules.list", "filter=enabled"],
      ["Rules", "rules.list", null],
    ],
  );
});

test("page overrides, <Ui off> and a hand-set to win; <Related> and table headers are left alone", () => {
  const sim = link("Pick <Ui>Room types</Ui> in the test rule.", "rules/the-rate-simulator");
  assert.equal(sim[0].to, undefined);
  const elsewhere = link("Tick <Ui>Room types</Ui> on the PMS tab.", "watch/the-pms-tab");
  assert.equal(elsewhere[0].to, "room-types");
  const off = link("<Ui off>Rules</Ui> and <Ui to=\"rules.new\">Rules</Ui>");
  assert.equal(off[0].to, undefined);
  assert.equal(off[1].to, "rules.new");
  const table = link("| <Ui>Rules</Ui> | x |\n|---|---|\n| <Ui>Rules</Ui> | y |");
  assert.deepEqual(table.map((x) => x.to ?? null), [null, "rules.list"]);
  const related = link("<Related>\n- [Rules](/docs/rules/how-rules-run) and the change log\n</Related>");
  assert.equal(related.length, 0);
  assert.equal(entryFor(dict, "billing/the-billing-page", "Status"), null, "a section override covers every page in it");
});

test("every dictionary entry is a place the docs may open, with values the app reads unchanged", () => {
  const pages = new Set(pagesMeta.map((p) => p.path));
  const check = (where, e) => {
    assert.ok(links.isDestination(e.to), `${where}: ${e.to}`);
    assert.equal(links.destination(e.to).docsLinkable, true, `${where}: ${e.to} needs an id`);
    const params = Object.fromEntries(new URLSearchParams(e.q ?? ""));
    assert.deepEqual(links.parseLink(e.to, params, { source: "docs" }).problems, [], `${where}: ${e.to}?${e.q ?? ""}`);
  };
  for (const [label, e] of Object.entries(dict.labels)) check(label, e);
  for (const [phrase, e] of Object.entries(dict.phrases)) if (e) check(phrase, e);
  for (const [page, overrides] of Object.entries(dict.pages)) {
    assert.ok(page.endsWith("/*") ? sections.some((s) => `${s.slug}/*` === page) : pages.has(page), `override for unknown page ${page}`);
    for (const [label, e] of Object.entries(overrides)) if (e) check(`${page} ${label}`, e);
  }
});

const IPW = "<InPlainWords>\nWords.\n</InPlainWords>\n\n";

test("the build refuses a link into MAYA it would change, drop or show to everyone", () => {
  const problems = (body) => extractPage(IPW + body).problems.map((p) => p.message);
  assert.deepEqual(problems('Read <AppLink to="review">the review</AppLink>.'), []);
  assert.deepEqual(problems('<OpenInMaya to="rules.new" name="Nearly full" occupancy="gt85" direction="increase" percent="10" words="Open the rule builder with this rule filled in" />'), []);
  assert.match(problems('<AppLink to="rules.edit">x</AppLink>').join(" "), /not a place in MAYA/);
  assert.match(problems('<AppLink to="calendar.day" date="2026-10-03">x</AppLink>').join(" "), /night or id/);
  assert.match(problems('<OpenInMaya to="rules.new" hotel="0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f" words="x" />').join(" "), /hotel/);
  assert.match(problems('<OpenInMaya to="rules.new" percent="90" words="x" />').join(" "), /percent/);
  assert.match(problems('<OpenInMaya to="rules.new" percent="10.0" words="x" />').join(" "), /would read as "10"/);
  assert.match(problems('<OpenInMaya to="rules.new" over="7" words="x" />').join(" "), /over/);
  assert.match(problems('<OpenInMaya to="rules.new" />').join(" "), /needs words/);
  assert.match(problems('Click <OpenInMaya to="rules.new" words="x" /> now.').join(" "), /line of its own/);
  assert.match(problems('<Ui to="nope">Rules</Ui>').join(" "), /not a place/);
});

test("a written-out link into the app is refused, so a visitor never gets one", () => {
  const raw = `---\ntitle: T\nsummary: S.\nsection: rules\norder: 10\nkeywords: [a]\nquestions:\n  - Q?\n---\n\n${IPW}See [the review](https://maya-rms.com/onboarding/review).\n`;
  const { problems } = loadPages([{ file: "rules/t.mdx", raw }], sections);
  assert.ok(problems.some((p) => /goes into MAYA for everyone/.test(p.message)), JSON.stringify(problems));
});

test("the pages' own buttons and links into MAYA are all valid, and none is in the helper's text", () => {
  const dir = path.join(ROOT, "content/docs");
  let buttons = 0;
  for (const p of pagesMeta) {
    const body = fs.readFileSync(path.join(dir, `${p.path}.mdx`), "utf8");
    buttons += (body.match(/<OpenInMaya /g) || []).length;
    const ex = extractPage(body.replace(/^---[\s\S]*?\n---\n/, ""));
    assert.deepEqual(ex.problems.filter((x) => /AppLink|OpenInMaya|Ui>/.test(x.message)), [], p.path);
    // The helper shows the same words to everyone: never a link into the app.
    for (const s of ex.sections) for (const b of s.blocks) assert.ok(!/\]\((https?:\/\/(www\.)?maya-rms\.com|\/go\/|\/\?)/.test(b.md), `${p.path}: ${b.md}`);
  }
  assert.ok(buttons >= 30, `${buttons} buttons`);
});

// Every page, as it renders: each place a page names is linked (the first
// time in its paragraph or table cell), and nothing that should stay words is.
// Checked from the rendered tree, not from the linker's own bookkeeping.
const SKIP_TYPES = new Set(["heading", "link", "linkReference", "inlineCode", "code", "definition", "html"]);
const SKIP_ELEMENTS = new Set(["Related", "OpenInMaya", "AppLink", "Ui"]);
const phraseKeys = Object.keys(dict.phrases).sort((a, b) => b.length - a.length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phraseRe = new RegExp(`(?<![\\p{L}\\p{N}])(${phraseKeys.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "gu");

function linkedPage(p) {
  const body = fs.readFileSync(path.join(ROOT, "content/docs", `${p.path}.mdx`), "utf8").replace(/^---[\s\S]*?\n---\n/, "");
  const tree = parseMdx(body);
  // What the page itself wrote: a hand-set to, or <Ui off>.
  (function mark(n) {
    if (n.name === "Ui") n.handSet = (n.attributes || []).some((a) => a.name === "to");
    (n.children || []).forEach(mark);
  })(tree);
  createAppLinker(dict)({ page: p.path })(tree);
  return tree;
}

function auditPage(p) {
  const tree = linkedPage(p);
  const problems = [];
  const stats = { ui: 0, phrases: 0, handSet: 0 };
  const where = (n) => `${p.path}:${n.position?.start?.line ?? "?"}`;
  const text = (n) => (n.type === "text" ? n.value : (n.children || []).map(text).join(""));

  (function visit(n, ctx) {
    const isLink = n.type === "mdxJsxTextElement" && (n.name === "AppLink" || (n.name === "Ui" && attrsOf(n).to));
    if (isLink) {
      if (ctx.heading) problems.push(`${where(n)} a link in a heading: ${text(n)}`);
      if (ctx.link) problems.push(`${where(n)} a link inside a link: ${text(n)}`);
      if (ctx.header) problems.push(`${where(n)} a link in a table header: ${text(n)}`);
    }
    if (n.type === "paragraph" || n.type === "tableCell") ctx = { ...ctx, used: new Set() };
    if (n.name === "Ui" && !ctx.skip) {
      const a = attrsOf(n);
      const label = text(n).replace(/\s+/g, " ").trim();
      const entry = "off" in a || n.handSet ? null : entryFor(dict, p.path, label);
      if (n.handSet) stats.handSet++;
      else if (a.to) {
        const key = `${a.to}?${a.q ?? ""}`;
        if (!entry || key !== `${entry.to}?${entry.q ?? ""}`) problems.push(`${where(n)} "${label}" linked to ${key}, not its entry`);
        if (ctx.used.has(key)) problems.push(`${where(n)} "${label}" linked twice in one paragraph`);
        ctx.used.add(key);
        stats.ui++;
      } else if (entry && !ctx.used.has(`${entry.to}?${entry.q ?? ""}`)) {
        problems.push(`${where(n)} "${label}" names ${entry.to} but is not linked`);
      }
    }
    if (n.name === "AppLink" && !n.position) {
      // made by the linker from a phrase
      const key = `${attrsOf(n).to}?${attrsOf(n).q ?? ""}`;
      if (ctx.skip) problems.push(`${where(n)} a phrase linked where nothing should be`);
      if (ctx.used.has(key)) problems.push(`${where(n)} "${text(n)}" linked twice in one paragraph`);
      ctx.used.add(key);
      stats.phrases++;
    }
    if (n.type === "text" && !ctx.skip) {
      for (const m of n.value.matchAll(phraseRe)) {
        const e = dict.phrases[m[1]];
        if (e && !ctx.used.has(`${e.to}?${e.q ?? ""}`)) problems.push(`${where(n)} "${m[1]}" names ${e.to} but is not linked`);
      }
    }
    const heading = ctx.heading || n.type === "heading";
    const link = ctx.link || isLink || n.type === "link" || n.type === "linkReference";
    const skip = ctx.skip || SKIP_TYPES.has(n.type) || SKIP_ELEMENTS.has(n.name);
    if (n.type === "table") {
      (n.children || []).forEach((row, i) => visit(row, { ...ctx, heading, link, skip: skip || i === 0, header: ctx.header || i === 0 }));
      return;
    }
    for (const c of n.children || []) visit(c, { ...ctx, heading, link, skip });
  })(tree, { used: new Set(), skip: false, heading: false, link: false, header: false });
  return { problems, stats };
}

test("every page: each place it names links once per paragraph, never in a heading, a link or a table header", () => {
  let problems = [];
  const total = { ui: 0, phrases: 0, handSet: 0 };
  for (const p of pagesMeta) {
    const r = auditPage(p);
    problems = problems.concat(r.problems);
    for (const k of Object.keys(total)) total[k] += r.stats[k];
  }
  assert.deepEqual(problems, []);
  assert.ok(total.ui > 900 && total.phrases > 600 && total.handSet >= 3, JSON.stringify(total));
});
