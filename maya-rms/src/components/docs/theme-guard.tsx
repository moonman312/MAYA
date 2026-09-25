"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { THEME_KEY, THEMED_PATHS } from "@/lib/docs/theme";

function preferredDark(): boolean {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored === "dark";
  } catch {
    // storage blocked: fall through to the system preference
  }
  return !window.matchMedia("(prefers-color-scheme: light)").matches;
}

/**
 * Rendered once in the root layout. On the docs and support pages it applies
 * the reader's stored theme (or the system's); everywhere else it takes the
 * class off, after a client-side move between the docs and the app.
 */
export function ThemeGuard() {
  const pathname = usePathname();
  useEffect(() => {
    const dark = THEMED_PATHS.test(pathname) ? preferredDark() : false;
    document.documentElement.classList.toggle("dark", dark);
  }, [pathname]);
  return null;
}
