// The docs build: page loading and checks, and the indexes it writes.
// Run with: npm test
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  loadPages,
  chunkBlocks,
  buildPagesMeta,
  buildSearchIndex,
  buildAskIndex,
  buildEvalFixture,
  checkSynonyms,
  readingTimeFor,
  validateFrontmatter,
  refsFor,
  roughWords,
  toWire,
  trimPassage,
  EVAL_SIZE,
  PASSAGE_SHOWN,
} from "./build-lib.mjs";
import { expandIndex } from "../../src/lib/docs/ask/match.ts";
import { extractPage, mdToPlain } from "./extract.mjs";
import { scanText } from "./leaks.mjs";

// Whole-corpus checks: slower than a unit test, and slower still when the suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sections = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/sections.json"), "utf8"));

const fm = (extra = {}) => {
  const base = {
    title: "Booking speed",
    summary: "How a night's bookings compare: with similar nights.",
    section: "rules",
    order: "50",
    keywords: "[pace, faster than normal]",
    questions: ["What is booking speed?", "Why is it Normal?", "Does a wedding count once?"],
    ...extra,
  };
  const lines = Object.entries(base).map(([k, v]) =>
    Array.isArray(v) ? `${k}:\n${v.map((q) => `  - ${q}`).join("\n")}` : `${k}: ${v}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
};

const page = (body, extra) => `${fm(extra)}\n${body}`;
const IPW = "<InPlainWords>\nBooking speed compares bookings.\n</InPlainWords>\n";

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function realFiles() {
  const dir = path.join(ROOT, "content/docs");
  return walk(dir)
    .filter((f) => f.endsWith(".mdx"))
    .map((f) => ({ file: path.relative(dir, f).split(path.sep).join("/"), raw: fs.readFileSync(f, "utf8") }));
}

test("a well-formed page loads with its title, sections, headings and reading time", () => {
  const body = `${IPW}\n## How a night reads\n\nFive similar Fridays. <Ui>Past week</Ui> is the window.\n\n### The levels\n\n| Level | Reads as |\n|---|---|\n| <Ui>Normal</Ui> | about the same |\n`;
  const { pages, problems } = loadPages([{ file: "rules/booking-speed.mdx", raw: page(body) }], sections);
  assert.deepEqual(problems, []);
  assert.equal(pages.length, 1);
  const p = pages[0];
  assert.equal(p.url, "/docs/rules/booking-speed");
  assert.equal(p.fm.summary, "How a night's bookings compare: with similar nights.", "a colon inside a summary is fine");
  assert.deepEqual(p.fm.keywords, ["pace", "faster than normal"]);
  assert.deepEqual(
    p.extract.headings.map((h) => [h.depth, h.id]),
    [
      [2, "how-a-night-reads"],
      [3, "the-levels"],
    ],
  );
  assert.equal(p.extract.ipw, "Booking speed compares bookings.");
  assert.equal(p.readingTime, 1);
});

test("the build refuses a page without In plain words first", () => {
  const { problems } = loadPages([{ file: "rules/x.mdx", raw: page("## Start\n\nText.\n") }], sections);
  assert.ok(problems.some((p) => /first thing on the page must be <InPlainWords>/.test(p.message)), JSON.stringify(problems));
});

test("the build refuses an unknown section, a folder mismatch and a missing field", () => {
  const bad = page(IPW, { section: "nowhere" });
  const { problems } = loadPages([{ file: "rules/x.mdx", raw: bad }], sections);
  assert.ok(problems.some((p) => /unknown section "nowhere"/.test(p.message)));
  assert.ok(problems.some((p) => /does not match its folder/.test(p.message)));
  const noSummary = page(IPW).replace(/^summary:.*\n/m, "");
  const r2 = loadPages([{ file: "rules/x.mdx", raw: noSummary }], sections);
  assert.ok(r2.problems.some((p) => p.message === 'missing "summary"'));
});

test("the build refuses a dead link and a link to a heading that does not exist", () => {
  const a = page(`${IPW}\n## One\n\nRead [two](/docs/rules/two) and [nothing](/docs/rules/nothing).\n`);
  const b = page(`${IPW}\n## Two\n\nSee [one](/docs/rules/one#no-such-heading) and [here](#two).\n`);
  const { problems } = loadPages(
    [
      { file: "rules/one.mdx", raw: a },
      { file: "rules/two.mdx", raw: b },
    ],
    sections,
  );
  const messages = problems.map((p) => p.message);
  assert.ok(messages.some((m) => m.includes('"/docs/rules/nothing" points at a page that does not exist')), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes('"/docs/rules/one#no-such-heading" points at no heading on rules/one')), messages.join("\n"));
  assert.equal(messages.filter((m) => m.includes("#two")).length, 0, "an anchor on the same page resolves");
});

test("a [words][ref] link gets the same checks as one written inline", () => {
  const body = `${IPW}\n## One\n\nSee [the review][r] and [pricing][p].\n\n[r]: https://maya-rms.com/onboarding/review\n[p]: /docs/start/no-such-page#nope\n`;
  const { problems } = loadPages([{ file: "rules/booking-speed.mdx", raw: page(body) }], sections);
  const messages = problems.map((p) => p.message);
  assert.ok(messages.some((m) => m.includes('"https://maya-rms.com/onboarding/review" goes into MAYA for everyone')), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes('"/docs/start/no-such-page#nope" points at a page that does not exist')), messages.join("\n"));
});

test("the build refuses a non-kebab slug and a duplicate path", () => {
  const { problems } = loadPages([{ file: "rules/Booking_Speed.mdx", raw: page(IPW) }], sections);
  assert.ok(problems.some((p) => /kebab-case/.test(p.message)));
});

test("an unknown component and a JavaScript expression are problems", () => {
  const { problems } = loadPages([{ file: "rules/x.mdx", raw: page(`${IPW}\n<Chart />\n\nPrice is {price}.\n`) }], sections);
  assert.ok(problems.some((p) => /unknown component <Chart>/.test(p.message)));
  assert.ok(problems.some((p) => /expression/.test(p.message)));
});

test("trailing source notes are stripped at build time, and notes anywhere else fail the leak scan", () => {
  const notes = "\n<!-- sources: /Users/someone/app/src/lib/explain.ts:141, MAYA_SECRET -->\n";
  const ok = loadPages([{ file: "rules/x.mdx", raw: page(`${IPW}\n## One\n\nText.\n${notes}`) }], sections);
  assert.deepEqual(ok.problems, [], "a trailing note is dropped before the scan");
  assert.ok(!ok.pages[0].body.includes("<!--"));

  const inside = loadPages([{ file: "rules/x.mdx", raw: page(`${IPW}\n<!-- note -->\n\n## One\n\nText.\n`) }], sections);
  assert.ok(inside.problems.some((p) => /HTML comment/.test(p.message)));

  const leak = loadPages([{ file: "rules/x.mdx", raw: page(`${IPW}\n## One\n\nSee src/lib/rules.ts for more.\n`) }], sections);
  assert.ok(leak.problems.some((p) => /code file name/.test(p.message)));
});

test("the leak scan catches home and temp paths on any machine, every setting name and code file names", () => {
  for (const [text, name] of [
    ["/home/user/MAYA/docs/pms-integrations-status.md", "home directory path"],
    ["See (/root/notes)", "home directory path"],
    ["~/MAYA/notes", "home directory path"],
    ["/Users/someone/app", "home directory path"],
    ["/tmp/claude-0/x/tasks/x", "temp path"],
    ["/var/folders/xy/T/x", "temp path"],
    ["/private/tmp/x", "temp path"],
    ["DOCS_ASK_DISABLED", "setting name"],
    ["SUPABASE_SERVICE_ROLE_KEY", "setting name"],
    ["CLOUDBEDS_CLIENT_SECRET", "setting name"],
    ["PMS_OAUTH_STATE_SECRET", "setting name"],
    ["MAYA_X", "setting name"],
    ["src/lib/deep-links/registry.json", "code file name"],
    ["scripts/docs-build.js", "code file name"],
    ["foo.tsx", "code file name"],
  ]) {
    assert.ok(scanText(text).some((h) => h.name === name), `${name} in ${text}: ${JSON.stringify(scanText(text))}`);
  }
  for (const text of ["Built on Next.js.", "https://www.get-maya.com/privacy", "Open /docs/start/what-maya-does from your home page.", "A 10/20 split."]) {
    assert.deepEqual(scanText(text), [], text);
  }
  for (const file of ["content/docs-questions.json", "src/lib/docs/synonyms.json"]) {
    assert.deepEqual(scanText(fs.readFileSync(path.join(ROOT, file), "utf8")), [], file);
  }
});

test("frontmatter validation lists every problem", () => {
  const problems = validateFrontmatter({ title: "", section: "rules", order: "x", keywords: [], questions: ["one"], pms: ["opera"], extra: 1 }, ["rules"]);
  for (const want of ['"title"', 'missing "summary"', '"order"', '"keywords"', '"questions"', '"pms"', 'unknown frontmatter key "extra"']) {
    assert.ok(problems.some((p) => p.includes(want)), `${want} in ${problems.join(" | ")}`);
  }
});

test("reading time is words over 200, rounded up, at least a minute", () => {
  assert.equal(readingTimeFor(0), 1);
  assert.equal(readingTimeFor(200), 1);
  assert.equal(readingTimeFor(201), 2);
  assert.equal(readingTimeFor(1999), 10);
});

test("tabs, steps, callouts and widgets become plain passages", () => {
  const body = `${IPW}
## Where

<PmsTabs>
<PmsTab pms="cloudbeds">
Reads confirmed bookings.
</PmsTab>
<PmsTab pms="mews">
Reads every reservation.
</PmsTab>
</PmsTabs>

<Steps>
<Step title="Open the night">
Click it.
</Step>
<Step>Type the price.</Step>
</Steps>

<Callout kind="not-yet">
You cannot edit a rule.
</Callout>

<OccupancySlider rooms={12} outOfService={2} booked={9} threshold={80} />

<Related>
- [Somewhere](/docs/rules/x)
</Related>
`;
  const ex = extractPage(body);
  assert.deepEqual(ex.problems, []);
  const md = ex.sections[1].blocks.map((b) => b.md).join("\n");
  assert.match(md, /\*\*Cloudbeds:\*\* Reads confirmed bookings\./);
  assert.match(md, /\*\*Mews:\*\* Reads every reservation\./);
  assert.match(md, /\*\*1\. Open the night\*\*/);
  assert.match(md, /2\. Type the price\./);
  assert.match(md, /\*\*Not yet\*\* · You cannot edit a rule\./);
  assert.match(md, /Twelve rooms, two out of service, nine booked: 90% sellable occupancy, so a Greater than 80 rule fires\./);
  assert.doesNotMatch(md, /Somewhere/, "Related links are not passage text");
  assert.equal(mdToPlain("**Bold** and [a link](/docs/x)"), "Bold and a link");
});

test("long sections split into passages, and bold-led entries stand alone", () => {
  const long = Array.from({ length: 6 }, (_, i) => ({ md: `Paragraph ${i} ${"word ".repeat(60)}` }));
  const chunks = chunkBlocks(long, 700);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.md.length <= 1400));
  const entries = chunkBlocks([
    { md: "Three things:" },
    { md: '- **"Invalid login credentials"**: wrong email or password.', lead: '"Invalid login credentials"', item: true },
    { md: '- **"Check your email"**: a link is on its way.', lead: '"Check your email"', item: true },
  ]);
  assert.equal(entries.length, 2, "the short lead-in joins the first entry");
  assert.equal(entries[0].lead, '"Invalid login credentials"');
  assert.match(entries[0].md, /^Three things:/);
});

test("a bank question can name the heading whose passage answers it", () => {
  const body = `${IPW}\n## How a night reads\n\nIt compares bookings.\n\n## No forecasts\n\nThere is no forecast.\n`;
  const { pages, problems: pageProblems } = loadPages([{ file: "rules/booking-speed.mdx", raw: page(body) }], sections);
  assert.deepEqual(pageProblems, []);
  const bank = [
    { q: "Do you forecast occupancy?", page: "rules/booking-speed", anchor: "no-forecasts" },
    { q: "What is booking speed?", page: "rules/booking-speed", anchor: "no-forecasts" },
    { q: "Is it magic?", page: "rules/booking-speed", anchor: "nowhere" },
  ];
  const { index, problems } = buildAskIndex(pages, sections, bank, []);
  const at = (q) => index.questions.find((x) => x.q === q);
  assert.equal(index.entries[at("Do you forecast occupancy?").e].a, "no-forecasts");
  assert.equal(index.entries[at("What is booking speed?").e].a, "no-forecasts", "the page's own question takes the bank's heading");
  assert.equal(at("Is it magic?"), undefined);
  assert.ok(problems.some((p) => /#nowhere, which is not a heading/.test(p)), JSON.stringify(problems));
});

test("a page question names its passage with {#anchor}, or the words a passage opens with", () => {
  const body = `${IPW}\n## Refunds\n\nWhat you pay is not refunded.\n\n## The levels\n\n- **Faster Than Normal.** More bookings than usual.\n- **Normal.** About the same.\n- **Stalled.** None at all.\n`;
  const questions = [
    "What is booking speed? {#in-plain-words}",
    "Can I get a refund? {#refunds}",
    "What does Stalled mean? {#the-levels/stalled}",
    "Is it magic? {#magic}",
  ];
  const { pages, problems: pageProblems } = loadPages([{ file: "rules/booking-speed.mdx", raw: page(body, { questions }) }], sections);
  assert.deepEqual(pageProblems, []);
  assert.deepEqual(pages[0].fm.questions.slice(0, 2), ["What is booking speed?", "Can I get a refund?"], "the rest of the build sees the words only");
  const { index, problems, stats } = buildAskIndex(pages, sections, [], []);
  const at = (q) => index.entries[index.questions.find((x) => x.q === q).e];
  assert.equal(at("What is booking speed?").ipw, 1);
  assert.equal(at("Can I get a refund?").a, "refunds");
  assert.equal(at("What does Stalled mean?").l, "Stalled");
  assert.ok(problems.some((p) => /booking-speed\.mdx: "Is it magic\?" points at rules\/booking-speed#magic, which is not a heading/.test(p)), JSON.stringify(problems));
  assert.equal(stats.withPassage, 3);
  const refs = refsFor(index.entries);
  assert.deepEqual(refs, ["in-plain-words", "refunds", "the-levels/faster-than-normal", "the-levels/normal", "the-levels/stalled"]);
});

test("the page and the bank must agree on a question's passage", () => {
  const body = `${IPW}\n## Refunds\n\nNot refunded.\n\n## Disputes\n\nEmail us.\n`;
  const questions = ["Can I get a refund? {#refunds}", "Two?", "Three?"];
  const { pages } = loadPages([{ file: "rules/booking-speed.mdx", raw: page(body, { questions }) }], sections);
  const { problems } = buildAskIndex(pages, sections, [{ q: "Can I get a refund?", page: "rules/booking-speed", anchor: "disputes" }], []);
  assert.ok(problems.some((p) => /but content\/docs\/rules\/booking-speed\.mdx points it at #refunds/.test(p)), JSON.stringify(problems));
});

test("a long passage is cut to what a reader needs, keeping the part that answers its questions", () => {
  const md = [
    "Where the price starts: your own rate, read from your system.",
    "A rule raises or cuts that price, between the floor and the ceiling.",
    "| Level | Reads as |\n|---|---|\n| Normal | about the same |\n| Stalled | no bookings |",
    "MAYA does not read competitor rates, weather or events.",
  ].join("\n\n");
  assert.deepEqual(trimPassage("Short.", 50), { md: "Short.", more: false });
  const head = trimPassage(md, 150);
  assert.equal(head.more, true);
  assert.ok(head.md.startsWith("Where the price starts") && head.md.length <= 150, head.md);
  const answer = trimPassage(md, 150, [roughWords("Does MAYA look at competitor rates?")]);
  assert.match(answer.md, /competitor rates/);
  const row = trimPassage(md, 90, [roughWords("What does Stalled mean?")]);
  assert.match(row.md, /^\| Level \| Reads as \|\n\|---\|---\|\n\| Normal/, "a table shows from its first row, never from the middle");
  assert.match(row.md, /Stalled/);
  const cut = trimPassage(md, 80, [roughWords("What does Stalled mean?")]);
  assert.ok(!/^\| Stalled/m.test(cut.md) || /\| Normal/.test(cut.md), "no run skips the rows above the one it wants");
  const long = trimPassage(`${"One sentence here. ".repeat(20)}`, 100);
  assert.ok(long.md.endsWith(".") && long.md.length <= 100, long.md);
});

test("the synonym check fails a group whose docs word is not in the docs", () => {
  assert.deepEqual(checkSynonyms([["price", "rate"]], "The price is set."), []);
  assert.equal(checkSynonyms([["tariff", "rate"]], "The price is set.").length, 1);
  assert.equal(checkSynonyms([["price"]], "price").length, 1, "a group needs another word");
});

test("the eval fixture is a stable spread of the bank", () => {
  const bank = Array.from({ length: 400 }, (_, i) => ({ q: `Question ${i}?`, page: "rules/x", bankSection: (i % 20) + 1 }));
  const a = buildEvalFixture(bank);
  const b = buildEvalFixture([...bank].reverse());
  assert.equal(a.length, EVAL_SIZE);
  assert.deepEqual(a.map((x) => x.q).sort(), b.map((x) => x.q).sort(), "order of the bank does not matter");
  const perSection = new Set(a.map((x) => bank.find((y) => y.q === x.q).bankSection));
  assert.equal(perSection.size, 20, "every bank section is represented");
});

// ── The real content ──────────────────────────────────────────────────

const real = loadPages(realFiles(), sections);

test("every page in content/docs passes the build's checks", () => {
  assert.deepEqual(
    real.problems.map((p) => `${p.file}:${p.line} ${p.message}`),
    [],
  );
  assert.ok(real.pages.length >= 100);
});

test("the search index has every page, its headings and their ids", () => {
  const index = buildSearchIndex(real.pages, sections);
  assert.equal(index.pages.length, real.pages.length);
  for (const p of index.pages) {
    assert.equal(p.h.length, p.hid.length);
    assert.ok(p.t && p.sum && p.k, p.u);
  }
  const text = JSON.stringify(index);
  assert.deepEqual(scanText(text), [], "nothing internal in the search index");
});

test("the helper's index covers every section, carries each page's In plain words first, and stays small", () => {
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "content/docs-questions.json"), "utf8"));
  const synonyms = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/synonyms.json"), "utf8"));
  const { index, problems } = buildAskIndex(real.pages, sections, bank, synonyms);
  assert.deepEqual(problems, []);
  real.pages.forEach((p, pi) => {
    const entries = index.entries.filter((e) => e.p === pi);
    const first = entries[0];
    assert.equal(first.ipw, 1, `${p.path} starts with its In plain words`);
    assert.ok(first.x.startsWith(p.extract.ipw.slice(0, 40)), `${p.path}: In plain words appears word for word`);
    for (const s of p.extract.sections.slice(1)) {
      if (!s.blocks.length) continue; // a heading with only sub-headings under it
      assert.ok(entries.some((e) => e.a === s.anchor), `${p.path}#${s.anchor} has a passage`);
    }
  });
  const norm = (q) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const indexed = new Set(index.questions.map((q) => `${norm(q.q)}|${index.pages[q.p].u}`));
  for (const item of bank) assert.ok(indexed.has(`${norm(item.q)}|/docs/${item.page}`), `bank: ${item.q}`);
  const json = JSON.stringify(toWire(index));
  assert.deepEqual(scanText(json), [], "nothing internal in the helper's index");
  assert.ok(zlib.gzipSync(json, { level: 9 }).length < 400 * 1024, "under 400 KB gzipped");
});

test("every question in the pages and the bank is tied to the passage that answers it", () => {
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "content/docs-questions.json"), "utf8"));
  const { index, stats } = buildAskIndex(real.pages, sections, bank, []);
  assert.equal(stats.questions, index.questions.length);
  // A page stands in only where no section fits; keep that rare.
  assert.ok(stats.pageOnly <= 5, `${stats.pageOnly} questions point at a page only`);
  const shown = index.entries.filter((e) => e.m);
  assert.ok(shown.every((e) => e.x.length <= PASSAGE_SHOWN), "a cut passage stays within what the helper shows");
});

test("the packed index unpacks to the same index", () => {
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "content/docs-questions.json"), "utf8"));
  const synonyms = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/synonyms.json"), "utf8"));
  const { index } = buildAskIndex(real.pages, sections, bank, synonyms);
  const back = expandIndex(JSON.parse(JSON.stringify(toWire(index))));
  assert.deepEqual(back, JSON.parse(JSON.stringify(index)));
});

test("page metadata carries FAQ entries for the troubleshooting pages only", () => {
  const meta = buildPagesMeta(real.pages, sections);
  assert.ok(meta.some((p) => p.section === "wrong" && p.faq.length > 0));
  assert.ok(meta.filter((p) => p.section !== "wrong").every((p) => p.faq.length === 0));
});

test("the committed generated files match the content", () => {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/pages.json"), "utf8"));
  assert.deepEqual(
    meta.map((p) => p.url),
    buildPagesMeta(real.pages, sections).map((p) => p.url),
    "run npm run docs:build and commit the result",
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/ask-manifest.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(ROOT, "public", manifest.file)), "the helper's index file is in public/");
});

test("the helper shows the price table from its first row", () => {
  const index = expandIndex(JSON.parse(fs.readFileSync(path.join(ROOT, "public", JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/ask-manifest.json"), "utf8")).file), "utf8")));
  const page = index.pages.findIndex((p) => p.u === "/docs/start/what-it-costs");
  const shown = index.entries.filter((e) => e.p === page && e.a === "the-brackets").map((e) => e.x).join("\n");
  assert.match(shown, /1 to 20/, shown);
  for (const e of index.entries) {
    const lines = e.x.split("\n");
    const first = lines.findIndex((l) => l.startsWith("|"));
    if (first < 0) continue;
    assert.ok(!/^\|?\s*-{3,}/.test(lines[first]), `${index.pages[e.p].u}#${e.a} starts a table on its divider`);
    if (lines[first + 1] !== undefined && lines[first + 1].startsWith("|")) {
      assert.match(lines[first + 1], /^\|?\s*-{3,}|^\|-/, `${index.pages[e.p].u}#${e.a} shows a table without its header: ${lines[first]}`);
    }
  }
});
