import { TEXT_SIZE_SCRIPT } from "@/lib/text-size";

/**
 * In the root layout's <head>: puts the person's text size on <html> before
 * the page paints, from the cookie Settings keeps (lib/text-size). Beside
 * ThemeScript, for the same reason: React only runs a script that arrives
 * with the first HTML.
 */
export function TextSizeScript() {
  return <script dangerouslySetInnerHTML={{ __html: TEXT_SIZE_SCRIPT }} />;
}
