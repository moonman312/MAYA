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
// Reads content/docs, the question bank (content/docs-questions.json), the
// everyday questions (content/docs-questions-everyday.json: the same shape,
// left out of the eval fixture), the helper's set replies
// (content/docs-helper-replies.json) and the synonyms.
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
  contentHash,
  ASK_BUDGET_BROTLI,
} from "./docs/build-lib.mjs";
import { scanText } from "./docs/leaks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = path.join(ROOT, "content/docs");
const BANK = path.join(ROOT, "content/docs-questions.json");
const EVERYDAY = path.join(ROOT, "content/docs-questions-everyday.json");
const REPLIES = path.join(ROOT, "content/docs-helper-replies.json");
const REGISTRY = path.join(ROOT, "src/lib/deep-links/registry.json");
const SYNONYMS = path.join(ROOT, "src/lib/docs/synonyms.json");
const SECTIONS = path.join(ROOT, "src/lib/docs/sections.json");
const GENERATED = path.join(ROOT, "src/lib/docs/generated");
const PUBLIC = path.join(ROOT, "public");

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

let bank = [];
let everyday = [];
let replies = {};
let synonyms = [];
for (const [file, set] of [
  [BANK, (v) => (bank = v)],
  [EVERYDAY, (v) => (everyday = v)],
  [REPLIES, (v) => (replies = v)],
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
const screens = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).help.screens;
const { index: askIndex, problems: bankProblems, stats: askStats } = buildAskIndex(pages, sectionList, bank, synonyms, {
  everyday,
  replies,
  screens,
});
const whereFile = { "question bank": rel(BANK), "everyday questions": rel(EVERYDAY), "helper replies": rel(REPLIES) };
for (const msg of bankProblems) {
  const [where, ...rest] = msg.split(": ");
  say(whereFile[where] ?? where, 0, rest.join(": "));
}
const evalFixture = buildEvalFixture(bank, askIndex);

const searchJson = JSON.stringify(searchIndex);
const askJson = JSON.stringify(toWire(askIndex));
const askHash = contentHash(askJson);
const askFile = `docs-index.${askHash}.json`;
const askGzip = zlib.gzipSync(askJson, { level: 9 }).length;
const askBrotli = zlib.brotliCompressSync(askJson, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
if (askBrotli > ASK_BUDGET_BROTLI) {
  say(
    askFile,
    0,
    `the docs helper's index is ${Math.round(askBrotli / 1024)} KB brotli (${Math.round(askGzip / 1024)} KB gzipped), over the ${ASK_BUDGET_BROTLI / 1024} KB brotli budget`,
  );
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

const manifest = {
  file: `/${askFile}`,
  pages: askIndex.pages.length,
  entries: askIndex.entries.length,
  questions: askIndex.questions.length,
  withPassage: askStats.withPassage,
  bytes: Buffer.byteLength(askJson),
  gzipBytes: askGzip,
  brotliBytes: askBrotli,
};

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
