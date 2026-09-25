// The longest, trickiest text a reader can send the docs feedback route.
// ask-feedback.test.mjs checks what the handler makes of it, and
// docs-questions-migration-sql.test.ts inserts those rows into the real table.
export const WORST_CASES = [
  // a short email at the end grows by two characters when it is scrubbed
  { source: "unanswered", question: `${"q".repeat(492)} jo@x.io` },
  // an email across the limit is scrubbed whole, never cut to "sam@" first
  { source: "not-helpful", question: `${"q".repeat(495)} sam@harbour-inn.com`, note: `${"n".repeat(994)} a@b.co ${"n".repeat(50)}` },
  // an emoji across the limit is never split in half
  { source: "unanswered", question: `${"q".repeat(499)}😀tail`, page: `/docs/${"é".repeat(250)}` },
  // 91 short pages: 1000 characters sent, 1090 once joined with ", "
  { source: "unanswered", question: "which page?", sectionsShown: Array(91).fill("/docs/abcd").join(",") },
];
