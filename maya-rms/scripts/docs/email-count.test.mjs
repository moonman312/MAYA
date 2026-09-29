// Every page that counts MAYA's own emails agrees with the page that lists them.
// Run with: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = path.join(ROOT, "content/docs");
const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// "MAYA itself sends four emails", "lists the four emails it does send",
// "The four emails MAYA sends", "MAYA's four emails".
const COUNT = new RegExp(
  `\\b(${WORDS.join("|")})\\s+(?:emails\\s+(?:MAYA|it)\\s+(?:itself\\s+)?(?:does\\s+)?send|emails\\s+MAYA\\s+sends)|` +
    `(?:sends|MAYA's)\\s+(${WORDS.join("|")})\\s+emails\\b`,
  "gi",
);

test("every page that counts MAYA's emails gives the count the emails page lists", () => {
  const listing = fs.readFileSync(path.join(DOCS, "billing/emails-maya-sends.mdx"), "utf8");
  const table = listing.split("## The ")[1] ?? "";
  const rows = table.split("\n").filter((l) => /^\| The /.test(l)).length;
  assert.ok(rows >= 1, "the emails page has its table");
  const expected = WORDS[rows - 1];

  const wrong = [];
  for (const file of walk(DOCS).filter((f) => f.endsWith(".mdx"))) {
    const raw = fs.readFileSync(file, "utf8");
    for (const m of raw.matchAll(COUNT)) {
      const said = (m[1] ?? m[2]).toLowerCase();
      if (said !== expected) wrong.push(`${path.relative(DOCS, file)}: "${m[0]}"`);
    }
  }
  assert.deepEqual(wrong, [], `the emails page lists ${expected}`);
});
