import { createTallyLimiter, handleTally } from "@/lib/docs/ask-tally";
import { readerSignedIn } from "@/lib/docs/reader-signed-in";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";

// Counts one question asked in the docs helper: what kind of reply it got
// (answered, unsure, a set reply or no answer), whether the reader was
// signed in, and the docs section or MAYA screen it was asked from. The
// helper sends it without waiting and never shows the result. No question
// text, no user id, no IP, no property: the row is the day and those four.
//
// Rows go to docs_ask_tally (99_supabase_migration_docs_ask_tally_v1.sql) and
// show on /admin and /admin/docs-questions. Anyone can send, signed in or not,
// so there are two limits, like the feedback route's but separate from them:
// one per reader (in memory, keyed on a daily-salted hash of the address,
// which is never stored) and one for everybody together (docsTally).

export const runtime = "nodejs";

const limiter = createTallyLimiter();

export async function POST(request: Request) {
  return handleTally(request, {
    limiter,
    shared: async () => (await rateLimit("docsTally", "all")).allowed,
    signedIn: readerSignedIn,
    write: isAdminConfigured()
      ? async (row) => {
          const { error } = await createAdminClient().from("docs_ask_tally").insert(row);
          if (error) throw new Error(error.message);
        }
      : null,
    log: (message, err) => console.error(JSON.stringify({ fn: "api/docs-ask/tally", message, error: err instanceof Error ? err.message : String(err) })),
  });
}
