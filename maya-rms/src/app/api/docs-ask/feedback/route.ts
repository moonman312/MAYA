import { cookies } from "next/headers";
import { createRateLimiter, handleFeedback } from "@/lib/docs/ask-feedback";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";

// Records a question the docs could not answer, a "this didn't help" note or
// a page vote, and only when the reader presses a button that sends it.
// Nothing here answers questions: the docs helper runs in the browser.
//
// Rows go to docs_questions (99_supabase_migration_docs_questions_v1.sql) and
// show on /admin/docs-questions. Anyone can send, signed in or not, so there
// are two limits: one per reader (in memory, keyed on a daily-salted hash of
// the address, which is never stored) and one for everybody together, so a
// loop cannot fill the table.

export const runtime = "nodejs";

const limiter = createRateLimiter();

async function signedIn(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  try {
    const { data } = await createClient(await cookies()).auth.getUser();
    return Boolean(data.user);
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const everyone = await rateLimit("docsQuestion", "all");
  if (!everyone.allowed) return new Response(null, { status: 429 });

  return handleFeedback(request, {
    limiter,
    write: isAdminConfigured()
      ? async (row) => {
          const { error } = await createAdminClient()
            .from("docs_questions")
            .insert({ ...row, signed_in: await signedIn() });
          if (error) throw new Error(error.message);
        }
      : null,
    log: (message, err) => console.error(JSON.stringify({ fn: "api/docs-ask/feedback", message, error: err instanceof Error ? err.message : String(err) })),
  });
}
