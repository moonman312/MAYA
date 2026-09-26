// Reading a docs page file. Run with: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { parseFrontmatter, splitFrontmatter, splitRef, stripTrailingNotes, withReadingTime } from "./source.mjs";

const RAW = `---
title: "Roles: who can do what"
summary: How MAYA counts: bookings, not rooms.
section: team
order: 10
keywords: [roles, 'viewer, read only', "hotel admin"]
questions:
  - Who can go live?
  - 'What does "Viewer" mean?'
  - Can a GM remove a GM?
pms: [cloudbeds, mews]
updated: 2026-09-24
---

<InPlainWords>
Four roles.
</InPlainWords>
`;

test("frontmatter and body split at the second --- line", () => {
  const { frontmatter, body, bodyLine } = splitFrontmatter(RAW);
  assert.match(frontmatter, /^title:/);
  assert.ok(body.startsWith("\n<InPlainWords>"));
  assert.equal(bodyLine, 14);
  assert.equal(splitFrontmatter("no frontmatter").frontmatter, null);
});

test("the frontmatter parser reads quoted titles, colons in summaries and both list forms", () => {
  const fm = parseFrontmatter(splitFrontmatter(RAW).frontmatter);
  assert.equal(fm.title, "Roles: who can do what");
  assert.equal(fm.summary, "How MAYA counts: bookings, not rooms.");
  assert.equal(fm.order, 10);
  assert.deepEqual(fm.keywords, ["roles", "viewer, read only", "hotel admin"]);
  assert.deepEqual(fm.questions, ["Who can go live?", 'What does "Viewer" mean?', "Can a GM remove a GM?"]);
  assert.deepEqual(fm.pms, ["cloudbeds", "mews"]);
  assert.equal(fm.updated, "2026-09-24");
  assert.equal(parseFrontmatter("note: 'It''s fine'").note, "It's fine");
  assert.throws(() => parseFrontmatter("just words"), /frontmatter line 2/);
});

test("a # inside a quoted value is kept, and an unquoted value is never cut short at one", () => {
  assert.equal(parseFrontmatter('title: "Rooms # and rates"').title, "Rooms # and rates");
  assert.equal(parseFrontmatter("title: 'Rooms # and rates' # a note").title, "Rooms # and rates");
  assert.equal(parseFrontmatter('title: "Say \\"# of rooms\\""').title, 'Say "# of rooms"');
  assert.equal(parseFrontmatter("title: Room #12").title, "Room #12", "a # with no space after it is just a character");
  assert.throws(() => parseFrontmatter("summary: Change the # of rooms you pay for."), /frontmatter line 2: " # " would cut the value short/);
  assert.throws(() => parseFrontmatter('title: ok\ntitle: "Rooms # x'), /frontmatter line 3: a value that starts with a quote must end with it/);
  assert.throws(() => parseFrontmatter('title: "Roles": who'), /frontmatter line 2/);
});

test("a number, true or false, or a list may carry a # comment, and a quoted phrase may open plain text", () => {
  assert.equal(parseFrontmatter("order: 10 # after the intro").order, 10);
  assert.equal(parseFrontmatter("order: -2.5 #").order, -2.5);
  assert.equal(parseFrontmatter("draft: true # for now").draft, true);
  assert.equal(parseFrontmatter("draft: false # for now").draft, false);
  assert.deepEqual(parseFrontmatter("keywords: [price, rates] # more later").keywords, ["price", "rates"]);
  assert.deepEqual(parseFrontmatter('keywords: [a, "rooms # x", \'b]\'] # c').keywords, ["a", "rooms # x", "b]"]);
  assert.throws(() => parseFrontmatter("keywords: [a, rooms # x]"), /frontmatter line 2: " # " would cut a list item short/);
  assert.equal(parseFrontmatter("summary: [Beta] how rates work").summary, "[Beta] how rates work");
  assert.equal(
    parseFrontmatter('summary: "How did we know?" explains every change.').summary,
    '"How did we know?" explains every change.',
  );
  assert.equal(parseFrontmatter('title: "Rates" vs "Rules"').title, '"Rates" vs "Rules"', "the quotes at both ends stay");
  assert.throws(() => parseFrontmatter('summary: "How did we know?" counts the # of rooms'), /" # " would cut the value short/);
  assert.throws(() => parseFrontmatter("summary: plain words # a note"), /" # " would cut the value short/);
  assert.throws(() => parseFrontmatter('title: "Roles": who'), /a colon after the closing quote/);
});

test("a question can end with the {#anchor} of the passage that answers it", () => {
  const fm = parseFrontmatter("questions:\n  - Can I get a refund? {#refunds}\n  - 'What does \"Unpaid\" mean?' {#when-a-payment-fails/the-status-becomes}\n  - Plain one?");
  assert.deepEqual(fm.questions, [
    "Can I get a refund? {#refunds}",
    'What does "Unpaid" mean? {#when-a-payment-fails/the-status-becomes}',
    "Plain one?",
  ]);
  assert.deepEqual(splitRef(fm.questions[1]), { text: 'What does "Unpaid" mean?', ref: "when-a-payment-fails/the-status-becomes" });
  assert.deepEqual(splitRef("Plain one?"), { text: "Plain one?", ref: null });
});

test("trailing source notes are removed, and only trailing ones", () => {
  const body = "Text.\n\n<!-- sources: rules §3 -->\n\n{/* more notes */}\n";
  assert.equal(stripTrailingNotes(body), "Text.\n");
  const middle = "Text.\n\n<!-- inside -->\n\nMore text.\n";
  assert.equal(stripTrailingNotes(middle), middle);
  assert.equal(stripTrailingNotes("Text.   \n\n"), "Text.\n");
});

test("the reading time is written into the frontmatter without touching anything else", () => {
  const next = withReadingTime(RAW, 8);
  assert.match(next, /^order: 10\nreadingTime: 8\nkeywords:/m);
  assert.equal(next.replace("readingTime: 8\n", ""), RAW);
  const again = withReadingTime(next, 9);
  assert.match(again, /^readingTime: 9$/m);
  assert.equal(again.match(/readingTime/g).length, 1);
  assert.equal(withReadingTime(next, 8), next, "unchanged when it already matches");
  const dollars = RAW.replace("How MAYA counts", "A $1 price");
  assert.ok(withReadingTime(dollars, 3).includes("A $1 price"), "dollar signs survive");
});
