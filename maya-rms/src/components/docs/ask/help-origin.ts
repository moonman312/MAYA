// Which MAYA screen opened the docs. "Help" in MAYA's header opens the docs
// page about that screen in a new tab with ?from=<screen> (see
// components/deep-links/help-links.tsx). The docs remember it for that tab,
// take it out of the address so a copied link stays clean, and the helper
// uses it to say where the reader came from and to count where questions are
// asked. It holds a screen name only, never anything the reader typed.

const KEY = "maya-docs-from";
const SHAPE = /^[a-z][a-z.-]{0,39}$/;

/** Reads ?from= once, keeps it for this tab, and drops it from the address. */
export function rememberHelpOrigin(): void {
  try {
    const url = new URL(window.location.href);
    const from = url.searchParams.get("from");
    if (from === null) return;
    if (SHAPE.test(from)) sessionStorage.setItem(KEY, from);
    url.searchParams.delete("from");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // storage blocked or no history: the helper works without it
  }
}

/** The screen that opened the docs in this tab, or null. */
export function helpOrigin(): string | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return v && SHAPE.test(v) ? v : null;
  } catch {
    return null;
  }
}
