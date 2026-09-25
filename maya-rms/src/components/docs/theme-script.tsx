import { THEME_SCRIPT } from "@/lib/docs/theme";

/**
 * In the root layout's <head>: sets the docs and support theme before paint.
 * It lives there rather than in the docs layout because React only runs a
 * script that arrives with the first HTML, never one added on navigation.
 */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
