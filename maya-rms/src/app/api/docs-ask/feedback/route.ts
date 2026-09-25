import { createRateLimiter, handleFeedback } from "@/lib/docs/ask-feedback";
import { readerSignedIn } from "@/lib/docs/reader-signed-in";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";

// Records a question the docs could not answer, a "this didn't help" note or
// a page vote, and only when the reader presses a button that sends it.
// Nothing here answers questions: the docs helper runs in the browser.
//
// Rows go to docs_questions (99_supabase_migration_docs_questions_v1.sql) and
// show on /admin/docs-questions. Anyone can send, signed in or not, so there
// are two limits: one per reader (in memory, keyed on a daily-salted hash of
// the address, which is never stored) and one for everybody together, so a
// loop cannot fill the table. The shared one is counted only for a valid post
// its reader's own limit let through, so one busy address cannot use it up,
// and page votes have their own, so they never use up the room for questions.
// A 429 says which limit it was ({ limited: "you" | "everyone" }), so the
// reader is never blamed for sends they did not make.

export const runtime = "nodejs";

const limiter = createRateLimiter();

export async function POST(request: Request) {
  return handleFeedback(request, {
    limiter,
    shared: async (budget) => (await rateLimit(budget === "vote" ? "docsVote" : "docsQuestion", "all")).allowed,
    write: isAdminConfigured()
      ? async (row) => {
          const { error } = await createAdminClient()
            .from("docs_questions")
            .insert({ ...row, signed_in: await readerSignedIn() });
          if (error) throw new Error(error.message);
        }
      : null,
    log: (message, err) => console.error(JSON.stringify({ fn: "api/docs-ask/feedback", message, error: err instanceof Error ? err.message : String(err) })),
  });
}
