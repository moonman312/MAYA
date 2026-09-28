// The docs helper's anonymous count: what a row holds, and the limits that
// keep a loop from filling the table. Run with: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { APP_AREAS, createTallyLimiter, handleTally, OUTCOMES, PLACES, TALLY_PER_HOUR } from "./ask-tally.ts";
import { createRateLimiter } from "./ask-feedback.ts";

const post = (body, ip = "203.0.113.7") =>
  new Request("http://localhost/api/docs-ask/tally", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function recorder() {
  const rows = [];
  return { rows, write: async (row) => void rows.push(row) };
}

test("a question asked writes the day, the kind of reply, signed in or not, and where; nothing else", async () => {
  const db = recorder();
  const res = await handleTally(
    post({ outcome: "none", section: "rules", appArea: "calendar", question: "why is my price $1?", page: "/docs/rules/booking-speed", email: "a@b.co" }),
    { limiter: createTallyLimiter(), write: db.write, signedIn: async () => true, now: () => new Date("2026-11-13T23:59:00Z") },
  );
  assert.equal(res.status, 204);
  assert.deepEqual(db.rows, [{ asked_on: "2026-11-13", outcome: "none", signed_in: true, section: "rules", app_area: "calendar" }]);
  const stored = JSON.stringify(db.rows);
  for (const never of ["price", "203.0.113.7", "a@b.co", "booking-speed"]) assert.ok(!stored.includes(never), never);
});

test("every outcome, place and MAYA screen is accepted; anything else is refused or dropped", async () => {
  assert.deepEqual([...OUTCOMES], ["answered", "unsure", "canned", "none"]);
  assert.ok(PLACES.includes("home") && PLACES.includes("support") && PLACES.includes("billing"));
  assert.ok(APP_AREAS.includes("calendar") && APP_AREAS.includes("rules.builder"));
  const db = recorder();
  const deps = { limiter: createRateLimiter({ perHour: 1000 }), write: db.write };
  for (const outcome of OUTCOMES) assert.equal((await handleTally(post({ outcome, section: "home" }), deps)).status, 204);
  for (const bad of [
    { outcome: "great", section: "home" },
    { outcome: "none" },
    { outcome: "none", section: "/docs/rules" },
    { outcome: "none", section: "Rules" },
    [],
  ]) {
    assert.equal((await handleTally(post(bad), deps)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await handleTally(post("not json"), deps)).status, 400);
  assert.equal((await handleTally(post({ outcome: "none", section: "home", pad: "x".repeat(2000) }), deps)).status, 413);
  // an app area the registry does not know is dropped, and the count still made
  await handleTally(post({ outcome: "answered", section: "support", appArea: "<script>" }), deps);
  assert.equal(db.rows.at(-1).app_area, "");
  assert.equal(db.rows.at(-1).signed_in, false, "no sign-in check means signed out");
});

test("one reader is held to its hourly limit, and the shared budget is asked only for rows that would be stored", async () => {
  const db = recorder();
  let sharedAsked = 0;
  const deps = {
    limiter: createTallyLimiter({ now: () => Date.parse("2026-11-13T10:00:00Z") }),
    write: db.write,
    shared: async () => (sharedAsked++, true),
  };
  for (let i = 0; i < TALLY_PER_HOUR; i++) assert.equal((await handleTally(post({ outcome: "canned", section: "home" }), deps)).status, 204);
  assert.equal((await handleTally(post({ outcome: "canned", section: "home" }), deps)).status, 429);
  assert.equal((await handleTally(post({ outcome: "canned", section: "home" }, "198.51.100.9"), deps)).status, 204, "another reader is fine");
  assert.equal((await handleTally(post({ outcome: "bogus", section: "home" }, "198.51.100.10"), deps)).status, 400);
  assert.equal(sharedAsked, TALLY_PER_HOUR + 1, "junk and a reader over its limit never touch the shared budget");
  const full = { ...deps, limiter: createTallyLimiter(), shared: async () => false };
  assert.equal((await handleTally(post({ outcome: "none", section: "home" }), full)).status, 429);
});

test("without a database the count is accepted and dropped; a failed write says so without detail", async () => {
  assert.equal((await handleTally(post({ outcome: "none", section: "home" }), { limiter: createTallyLimiter(), write: null })).status, 204);
  const logged = [];
  const res = await handleTally(post({ outcome: "none", section: "home" }), {
    limiter: createTallyLimiter(),
    write: async () => {
      throw new Error("relation does not exist");
    },
    log: (m) => logged.push(m),
  });
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "");
  assert.equal(logged.length, 1);
});
