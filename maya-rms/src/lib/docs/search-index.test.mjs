// The docs search box's index. Run with: npm test
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSearch, searchDocs } from "./search-index.ts";

// Whole-corpus checks: slower than a unit test, and slower still when the suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const generated = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/index.json"), "utf8"));
const pagesMeta = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/pages.json"), "utf8"));
const search = buildSearch(generated.pages);

test("every docs page is in the search index, with its headings and their ids", () => {
  assert.equal(generated.pages.length, pagesMeta.length);
  for (const meta of pagesMeta) {
    const p = generated.pages.find((x) => x.u === meta.url);
    assert.ok(p, meta.url);
    assert.deepEqual(p.hid, meta.headings.map((h) => h.id));
  }
});

test("a title search puts that page first", () => {
  assert.equal(searchDocs(search, "booking speed")[0].url, "/docs/rules/booking-speed");
  assert.equal(searchDocs(search, "reset password")[0].url, "/docs/recipes/reset-your-password");
  assert.equal(searchDocs(search, "floors and ceilings")[0].url, "/docs/review/floors-and-ceilings");
});

test("prefixes and small typos still find the page", () => {
  assert.ok(searchDocs(search, "sellable occ").some((r) => r.url === "/docs/rules/sellable-occupancy"));
  assert.ok(searchDocs(search, "cloudbeds disconect").some((r) => r.url === "/docs/connect/reconnect-and-disconnect" || r.url === "/docs/connect/cloudbeds"));
});

test("results are at most ten, grouped by section, and name the heading that matched", () => {
  const results = searchDocs(search, "price");
  assert.ok(results.length > 0 && results.length <= 10);
  const seen = [];
  for (const r of results) {
    if (seen[seen.length - 1] !== r.section) {
      assert.ok(!seen.includes(r.section), `section ${r.section} appears in one group`);
      seen.push(r.section);
    }
  }
  const withHeading = searchDocs(search, "wedding weekend").find((r) => r.url === "/docs/wrong/start-here");
  assert.ok(withHeading && withHeading.anchor, "the heading that matched comes with its anchor");
});

test("an empty query finds nothing and a nonsense one finds nothing", () => {
  assert.deepEqual(searchDocs(search, "  "), []);
  assert.deepEqual(searchDocs(search, "zzqxv"), []);
});
