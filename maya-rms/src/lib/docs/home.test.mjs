// Hand-picked links on the docs home and support page. Run with: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_STARTERS, PMS_CARDS, START_WHERE_YOU_ARE, SUPPORT_STARTERS, TOP_QUESTIONS } from "./home.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pages = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/docs/generated/pages.json"), "utf8"));
const legacy = fs.readFileSync(path.join(ROOT, "src/components/support/legacy-anchors.tsx"), "utf8");

function resolves(href) {
  const [url, anchor] = href.split("#");
  const page = pages.find((p) => p.url === url);
  if (!page) return false;
  return !anchor || page.headings.some((h) => h.id === anchor);
}

test("every hand-picked link reaches a page and, where given, a heading on it", () => {
  for (const item of [...TOP_QUESTIONS, ...START_WHERE_YOU_ARE, ...PMS_CARDS]) {
    assert.ok(resolves(item.href), item.href);
  }
  assert.equal(TOP_QUESTIONS.length, 10);
  assert.equal(START_WHERE_YOU_ARE.length, 6);
});

test("the old support page anchors all send readers to real docs pages", () => {
  const targets = [...legacy.matchAll(/"(\/docs\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 20);
  for (const t of targets) assert.ok(resolves(t), t);
});

test("the helper's starters are six short questions each", () => {
  for (const list of [HOME_STARTERS, SUPPORT_STARTERS]) {
    assert.equal(list.length, 6);
    for (const q of list) assert.ok(q.length < 80 && !/[–—!]/.test(q), q);
  }
});
