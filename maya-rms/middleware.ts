import { updateSession } from "@/utils/supabase/middleware";
import { type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

// The docs and support pages are public and built ahead of time, so they skip
// the session refresh (they find out on their own, in the browser, whether
// the reader is signed in). So do the docs helper's index, the sitemap,
// llms.txt and the share image. So does the screenshot reader's engine
// (public/tesseract), which is only ever static files.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|docs(?:/|$)|support$|docs-index\\.|tesseract/|sitemap\\.xml|robots\\.txt|llms\\.txt$|opengraph-image|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
