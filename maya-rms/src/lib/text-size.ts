/**
 * Each person's text size (Settings, Display): Standard, Large or Larger.
 *
 * The app sizes its text and spacing in rem (Tailwind's scale), so the size
 * is the root font size: 100%, 112.5% or 125% (globals.css, keyed on
 * html[data-text-size]). It is saved on the person's profile so it follows
 * them to any device, and mirrored in a cookie so a page opens at the right
 * size: TEXT_SIZE_SCRIPT runs in the root layout's <head>, before the first
 * paint, on every page (the dashboard, the docs, the account and admin
 * pages), so nothing is ever drawn at the wrong size first. The pages built
 * ahead of time (the docs) keep being built ahead of time: the root layout
 * never reads the cookie. When the cookie is out of step with the profile
 * (a size chosen on another device, someone else's cookie), the dashboard
 * page, which reads both on the server, sends textSizeFixScript ahead of the
 * dashboard, and each sign-in path copies the profile's size to the cookie
 * before the first page (syncTextSizeFromProfile).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const TEXT_SIZES = ["standard", "large", "larger"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  standard: "Standard",
  large: "Large",
  larger: "Larger",
};

/** The root font size for each, as globals.css sets it. */
export const TEXT_SIZE_SCALE: Record<TextSize, string> = {
  standard: "100%",
  large: "112.5%",
  larger: "125%",
};

export const TEXT_SIZE_COOKIE = "maya-text-size";
export const TEXT_SIZE_ATTRIBUTE = "data-text-size";

/** 400 days, the longest a browser keeps a cookie. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export function isTextSize(v: unknown): v is TextSize {
  return typeof v === "string" && (TEXT_SIZES as readonly string[]).includes(v);
}

/**
 * Runs in the <head> before the page paints (see TextSizeScript). Standard
 * is no attribute at all, so a person who never chose a size gets exactly
 * the page everyone gets. Keep it tiny and dependency-free.
 */
export const TEXT_SIZE_SCRIPT = `try{var m=document.cookie.match(/(?:^|;\\s*)${TEXT_SIZE_COOKIE}=(large|larger)(?:;|$)/);if(m)document.documentElement.setAttribute("${TEXT_SIZE_ATTRIBUTE}",m[1]);else document.documentElement.removeAttribute("${TEXT_SIZE_ATTRIBUTE}")}catch(e){}`;

/**
 * The dashboard's fix for a browser whose cookie holds another size than the
 * profile (a size chosen on another device, someone else's left behind). The
 * dashboard page reads both on the server and, when they differ, puts this
 * ahead of everything it draws: it sets the saved size on <html> and in the
 * cookie while the page is still loading, so nothing is drawn at the old
 * size. Keep it tiny and dependency-free, like TEXT_SIZE_SCRIPT.
 */
export function textSizeFixScript(size: TextSize): string {
  const s = JSON.stringify(isTextSize(size) ? size : "standard");
  const a = JSON.stringify(TEXT_SIZE_ATTRIBUTE);
  const c = JSON.stringify(TEXT_SIZE_COOKIE);
  return `try{var s=${s},d=document.documentElement,x=location.protocol==="https:"?"; Secure":"";if(s==="standard")d.removeAttribute(${a});else d.setAttribute(${a},s);document.cookie=s==="standard"?${c}+"=; Path=/; Max-Age=0; SameSite=Lax"+x:${c}+"="+s+"; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax"+x}catch(e){}`;
}

/** The size a cookie's value names; standard for none or one it does not know. */
export function textSizeFromCookieValue(value: string | undefined | null): TextSize {
  return isTextSize(value) ? value : "standard";
}

/** The size a cookie string holds; standard when it holds none. */
export function textSizeFromCookie(cookie: string): TextSize {
  const m = new RegExp(`(?:^|;\\s*)${TEXT_SIZE_COOKIE}=([^;]*)`).exec(cookie);
  const v = m ? decodeURIComponent(m[1]) : "";
  return isTextSize(v) ? v : "standard";
}

/** The size this page is showing now. */
export function currentTextSize(): TextSize {
  if (typeof document === "undefined") return "standard";
  const v = document.documentElement.getAttribute(TEXT_SIZE_ATTRIBUTE);
  return isTextSize(v) ? v : "standard";
}

/**
 * Shows the page at this size at once and remembers it on this browser for
 * the next page load. Saving it on the profile is the caller's part.
 */
export function applyTextSize(size: TextSize): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (size === "standard") root.removeAttribute(TEXT_SIZE_ATTRIBUTE);
  else root.setAttribute(TEXT_SIZE_ATTRIBUTE, size);
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      size === "standard"
        ? `${TEXT_SIZE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
        : `${TEXT_SIZE_COOKIE}=${size}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  } catch {
    // Cookies blocked: the size still shows on this page.
  }
}

/**
 * Just after sign-in: the size saved on the profile, on this browser before
 * the first page opens. Anything that goes wrong leaves the browser as it
 * was; the dashboard puts it right on its first load.
 */
export async function syncTextSizeFromProfile(supabase: SupabaseClient, userId: string | null): Promise<void> {
  if (!userId) return;
  try {
    const { data, error } = await supabase.from("profiles").select("text_size").eq("id", userId).maybeSingle();
    const v = (data as { text_size?: unknown } | null)?.text_size;
    if (!error && isTextSize(v) && v !== currentTextSize()) applyTextSize(v);
  } catch {
    // Signing in never waits on this.
  }
}
