#!/usr/bin/env node
// Builds everything the docs read from content/docs, and refuses to build
// when a page is broken. Runs before `next build` (see "prebuild").
//
//   node scripts/docs-build.mjs          build, and write reading times back into pages
//   node scripts/docs-build.mjs --check  report problems only, write nothing
//
// Writes:
//   src/lib/docs/generated/pages.json         page list, headings, metadata (server)
//   src/lib/docs/generated/index.json         the search index (browser, loaded on focus)
//   src/lib/docs/generated/ask-manifest.json  where the docs helper's index lives
//   src/lib/docs/generated/ask-eval.json      held-out bank questions for the matcher tests
//   public/docs-index.<hash>.json         the docs helper's index (browser, loaded when the panel opens)
//
// Needs no environment variables.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { withReadingTime } from "../src/lib/docs/source.mjs";
import {
  loadPages,
  buildPagesMeta,
  buildSearchIndex,
  buildAskIndex,
  buildEvalFixture,
  toWire,
  checkSynonyms,
  checkAppLabels,
  buildAskManifest,
} from "./docs/build-lib.mjs";
import { scanText } from "./docs/leaks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = path.join(ROOT, "content/docs");
const BANK = path.join(ROOT, "content/docs-questions.json");
const SYNONYMS = path.join(ROOT, "src/lib/docs/synonyms.json");
const SECTIONS = path.join(ROOT, "src/lib/docs/sections.json");
const APP_LABELS = path.join(ROOT, "src/lib/docs/app-labels.json");
const GENERATED = path.join(ROOT, "src/lib/docs/generated");
const PUBLIC = path.join(ROOT, "public");
// The helper's index loads when the panel opens, so it has a budget: 400 KB gzipped.
const ASK_BUDGET_GZIP = 400 * 1024;

const checkOnly = process.argv.includes("--check");
const started = Date.now();
const rel = (p) => path.relative(ROOT, p);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const problems = [];
const say = (file, line, message) => problems.push({ file, line, message });

const sectionList = JSON.parse(fs.readFileSync(SECTIONS, "utf8"));
const files = walk(CONTENT)
  .filter((f) => {
    if (f.endsWith(".mdx")) return true;
    say(rel(f), 0, "only .mdx pages belong in content/docs");
    return false;
  })
  .sort()
  .map((f) => ({ file: path.relative(CONTENT, f).split(path.sep).join("/"), raw: fs.readFileSync(f, "utf8") }));

const { pages, problems: pageProblems } = loadPages(files, sectionList);
for (const p of pageProblems) say(`content/docs/${p.file}`, p.line, p.message);

// The linker adds its links only when a page renders, so check its list here.
let appLabels = null;
try {
  appLabels = JSON.parse(fs.readFileSync(APP_LABELS, "utf8"));
} catch (err) {
  say(rel(APP_LABELS), 0, `not valid JSON: ${err.message}`);
}
if (appLabels) {
  const found = checkAppLabels(appLabels, pages.map((p) => p.path), sectionList.map((s) => s.slug));
  for (const msg of found) say(rel(APP_LABELS), 0, msg);
}

let bank = [];
let synonyms = [];
for (const [file, set] of [
  [BANK, (v) => (bank = v)],
  [SYNONYMS, (v) => (synonyms = v)],
]) {
  const text = fs.readFileSync(file, "utf8");
  for (const hit of scanText(text)) say(rel(file), hit.line, `${hit.name} "${hit.found}" in ...${hit.context}...`);
  try {
    set(JSON.parse(text));
  } catch (err) {
    say(rel(file), 0, `not valid JSON: ${err.message}`);
  }
}

const corpus = pages.map((p) => `${p.fm.title}\n${p.plain}\n${p.fm.keywords.join(", ")}`).join("\n");
for (const msg of checkSynonyms(synonyms, corpus)) say(rel(SYNONYMS), 0, msg);

const pagesMeta = buildPagesMeta(pages, sectionList);
const searchIndex = buildSearchIndex(pages, sectionList);
const { index: askIndex, problems: bankProblems, stats: askStats } = buildAskIndex(pages, sectionList, bank, synonyms);
for (const msg of bankProblems) {
  const [where, ...rest] = msg.split(": ");
  say(where === "question bank" ? rel(BANK) : where, 0, rest.join(": "));
}

const searchJson = JSON.stringify(searchIndex);
const askJson = JSON.stringify(toWire(askIndex));
const manifest = buildAskManifest(askIndex, askStats, askJson);
const askFile = manifest.file.slice(1);
// Compressed sizes are for the budget and the summary only: gzip's depends
// on the machine's zlib, so neither goes into the committed manifest.
const askGzip = zlib.gzipSync(askJson, { level: 9 }).length;
const askBrotli = zlib.brotliCompressSync(askJson, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
if (askGzip > ASK_BUDGET_GZIP) {
  say(askFile, 0, `the docs helper's index is ${Math.round(askGzip / 1024)} KB gzipped, over the ${ASK_BUDGET_GZIP / 1024} KB budget`);
}

for (const [name, text] of [
  ["src/lib/docs/generated/index.json", searchJson],
  [`public/${askFile}`, askJson],
]) {
  for (const hit of scanText(text)) say(name, hit.line, `${hit.name} "${hit.found}" in ...${hit.context}...`);
}

if (problems.length) {
  console.error(`\nThe docs build found ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n`);
  for (const p of problems) console.error(`  ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
  console.error("\nFix these and build again.\n");
  process.exit(1);
}

// Only from a bank that passed its checks: every question's pages are real.
const evalFixture = buildEvalFixture(bank, askIndex);

if (!checkOnly) {
  let rewritten = 0;
  for (const page of pages) {
    if (page.fm.readingTime === page.readingTime) continue;
    const next = withReadingTime(page.raw, page.readingTime);
    if (next !== page.raw) {
      fs.writeFileSync(path.join(CONTENT, page.file), next);
      rewritten++;
    }
  }
  fs.mkdirSync(GENERATED, { recursive: true });
  const write = (file, text) => {
    const target = path.join(GENERATED, file);
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== text) fs.writeFileSync(target, text);
  };
  write("pages.json", JSON.stringify(pagesMeta, null, 1) + "\n");
  write("index.json", searchJson + "\n");
  write("ask-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  write("ask-eval.json", "[\n" + evalFixture.map((e) => JSON.stringify(e)).join(",\n") + "\n]\n");
  for (const f of fs.readdirSync(PUBLIC)) {
    if (/^docs-index\.[0-9a-f]+\.json$/.test(f) && f !== askFile) fs.rmSync(path.join(PUBLIC, f));
  }
  const askPath = path.join(PUBLIC, askFile);
  if (!fs.existsSync(askPath)) fs.writeFileSync(askPath, askJson);
  if (rewritten) console.log(`docs: updated the reading time on ${rewritten} page${rewritten === 1 ? "" : "s"}`);
}

console.log(
  `docs: ${pages.length} pages, ${askIndex.entries.length} passages, ${askIndex.questions.length} questions ` +
    `(${askStats.withPassage} tied to a passage, ${askStats.pageOnly} to a page only), ` +
    `helper index ${Math.round(askGzip / 1024)} KB gzipped (${Math.round(askBrotli / 1024)} KB brotli), ` +
    `${Date.now() - started} ms${checkOnly ? " (check only)" : ""}`,
);
