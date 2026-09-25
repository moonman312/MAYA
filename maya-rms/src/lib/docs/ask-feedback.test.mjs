// The feedback route's guardrails. Run with: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { createRateLimiter, handleFeedback, scrub, LIMITS } from "./ask-feedback.ts";
import { WORST_CASES } from "./ask-feedback.fixtures.mjs";

const post = (body, ip = "203.0.113.7") =>
  new Request("http://localhost/api/docs-ask/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function recorder() {
  const rows = [];
  return { rows, write: async (row) => void rows.push(row) };
}

test("emails, phone numbers and card-length digit runs are removed", () => {
  assert.equal(scrub("I'm sam@harbour-inn.com, call +1 (415) 555-0132"), "I'm [removed], call [removed]");
  assert.equal(scrub("card 4242 4242 4242 4242 expires"), "card [removed] expires");
  assert.equal(scrub("card 4242424242424242"), "card [removed]");
  assert.equal(scrub("uk 07700 900123 please"), "uk [removed] please");
  // ordinary numbers stay
  assert.equal(scrub("Why is Saturday $1 on 2026-11-14 with 12 rooms at 80%?"), "Why is Saturday $1 on 2026-11-14 with 12 rooms at 80%?");
  assert.equal(scrub("$99,999.99 ceiling"), "$99,999.99 ceiling");
});

test("an unanswered question is written scrubbed, with the page and the time, and no identifier", async () => {
  const db = recorder();
  const res = await handleFeedback(
    post({ source: "unanswered", question: "email me at a@b.co about Mews", page: "/docs/connect/mews", sectionsShown: "/docs/connect/mews, https://evil.example" }),
    { limiter: createRateLimiter(), write: db.write, now: () => new Date("2026-11-13T18:05:00Z") },
  );
  assert.equal(res.status, 204);
  assert.deepEqual(db.rows, [
    {
      created_at: "2026-11-13T18:05:00.000Z",
      source: "unanswered",
      question: "email me at [removed] about Mews",
      page: "/docs/connect/mews",
      sections_shown: "/docs/connect/mews",
      note: "",
    },
  ]);
  assert.ok(!JSON.stringify(db.rows[0]).includes("203.0.113.7"), "no IP is stored");
});

test("a page vote writes the page and the button, and no text", async () => {
  const db = recorder();
  const res = await handleFeedback(post({ source: "page-not-useful", page: "/docs/rules/booking-speed", question: "ignored", note: "ignored" }), {
    limiter: createRateLimiter(),
    write: db.write,
  });
  assert.equal(res.status, 204);
  assert.equal(db.rows[0].question, "");
  assert.equal(db.rows[0].note, "");
  assert.equal(db.rows[0].source, "page-not-useful");
});

test("the 21st post in an hour from one address gets a 429, others are unaffected, and the hour passes", async () => {
  let now = Date.parse("2026-11-13T10:00:00Z");
  const limiter = createRateLimiter({ now: () => now });
  const db = recorder();
  const deps = { limiter, write: db.write };
  for (let i = 0; i < 20; i++) {
    const res = await handleFeedback(post({ source: "unanswered", question: `q${i}` }), deps);
    assert.equal(res.status, 204, `post ${i + 1}`);
  }
  assert.equal((await handleFeedback(post({ source: "unanswered", question: "one more" }), deps)).status, 429);
  assert.equal((await handleFeedback(post({ source: "unanswered", question: "someone else" }, "198.51.100.2"), deps)).status, 204);
  now += 61 * 60 * 1000;
  assert.equal((await handleFeedback(post({ source: "unanswered", question: "an hour later" }), deps)).status, 204);
  assert.equal(db.rows.length, 22);
});

test("the shared limit is only counted for a valid post its reader's own limit let through", async () => {
  let asked = 0;
  let open = true;
  const db = recorder();
  const deps = {
    limiter: createRateLimiter({ perHour: 1 }),
    write: db.write,
    shared: async () => {
      asked++;
      return open;
    },
  };
  assert.equal((await handleFeedback(post({ source: "nope", question: "x" }), deps)).status, 400);
  assert.equal((await handleFeedback(post({ source: "unanswered", question: "" }), deps)).status, 400);
  assert.equal(asked, 0, "junk never reaches the shared limit");
  assert.equal((await handleFeedback(post({ source: "unanswered", question: "first" }), deps)).status, 204);
  assert.equal((await handleFeedback(post({ source: "unanswered", question: "second" }), deps)).status, 429);
  assert.equal(asked, 1, "a reader over their own limit never reaches it either");
  open = false;
  assert.equal((await handleFeedback(post({ source: "unanswered", question: "someone else" }, "198.51.100.9"), deps)).status, 429);
  assert.equal(asked, 2);
  assert.deepEqual(db.rows.map((r) => r.question), ["first"]);
});

test("with no database configured nothing is written and the route still answers 204", async () => {
  const res = await handleFeedback(post({ source: "unanswered", question: "anything" }), { limiter: createRateLimiter(), write: null });
  assert.equal(res.status, 204);
});

test("bad input is refused before anything is written", async () => {
  const db = recorder();
  const deps = { limiter: createRateLimiter(), write: db.write };
  assert.equal((await handleFeedback(post("not json"), deps)).status, 400);
  assert.equal((await handleFeedback(post([1, 2]), deps)).status, 400);
  assert.equal((await handleFeedback(post({ source: "spam", question: "x" }), deps)).status, 400);
  assert.equal((await handleFeedback(post({ source: "unanswered" }), deps)).status, 400, "a question is needed");
  assert.equal((await handleFeedback(post({ source: "page-useful" }), deps)).status, 400, "a page is needed");
  assert.equal((await handleFeedback(post({ source: "page-useful", page: "https://elsewhere.example" }), deps)).status, 400);
  assert.equal((await handleFeedback(post({ source: "unanswered", question: "x".repeat(LIMITS.bodyBytes) }), deps)).status, 413);
  assert.equal(db.rows.length, 0);
});

test("long text is cut to its limit, and a failed write says so", async () => {
  const db = recorder();
  await handleFeedback(post({ source: "not-helpful", question: "q".repeat(900), note: "n".repeat(3000) }), { limiter: createRateLimiter(), write: db.write });
  assert.equal(db.rows[0].question.length, LIMITS.question);
  assert.ok(db.rows[0].note.length <= LIMITS.note);
  const logged = [];
  const res = await handleFeedback(post({ source: "unanswered", question: "q" }), {
    limiter: createRateLimiter(),
    write: async () => {
      throw new Error("quota");
    },
    log: (m) => logged.push(m),
  });
  assert.equal(res.status, 502);
  assert.equal(logged.length, 1);
});

const codePoints = (s) => Array.from(s).length;

test("text is scrubbed before it is cut, so every field fits its limit and no email half survives", async () => {
  const db = recorder();
  for (const body of WORST_CASES) {
    const res = await handleFeedback(post(body), { limiter: createRateLimiter(), write: db.write });
    assert.equal(res.status, 204);
  }
  for (const row of db.rows) {
    assert.ok(codePoints(row.question) <= LIMITS.question, `question ${codePoints(row.question)}`);
    assert.ok(codePoints(row.note) <= LIMITS.note, `note ${codePoints(row.note)}`);
    assert.ok(codePoints(row.page) <= LIMITS.page, `page ${codePoints(row.page)}`);
    assert.ok(codePoints(row.sections_shown) <= LIMITS.sections, `sections ${codePoints(row.sections_shown)}`);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(JSON.stringify(row)), "no half emoji");
  }
  const [jo, sam, emoji, pages] = db.rows;
  assert.ok(!jo.question.includes("jo@"), jo.question.slice(-12));
  assert.ok(!sam.question.includes("sam"), sam.question.slice(-12));
  assert.ok(!sam.note.includes("a@b"), "the note's email is scrubbed too");
  assert.equal(emoji.question, `${"q".repeat(499)}😀`);
  assert.ok(pages.sections_shown.split(", ").every((p) => p === "/docs/abcd"), "pages are kept whole");
});

test("scrubbing drops half an emoji a reader's browser sent", () => {
  assert.equal(scrub("broken \ud83d here"), "broken  here");
  assert.equal(scrub("fine 😀"), "fine 😀");
});
