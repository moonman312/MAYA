"use client";

import { useSyncExternalStore } from "react";
import { isSupabaseConfigured } from "@/utils/supabase/shared";

// Is the reader signed in to MAYA in this browser? The docs pages are static
// HTML that never holds a link into the app; after they load, this asks the
// app's own Supabase session, and only a signed-in reader sees "Open in MAYA"
// links. Nothing here is a security boundary: every link goes through /go,
// which checks the session again and sends anyone else to sign in.
//
// Cheap for a visitor: without a Supabase session cookie nothing is loaded.
// With one, the browser client is loaded once and asked for the session,
// which also refreshes an expired one the way the app always does.

const AUTH_COOKIE = /(?:^|;\s*)sb-[^=;]+-auth-token(?:\.\d+)?=/;

let signedIn = false;
let checking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(value: boolean) {
  if (value === signedIn) return;
  signedIn = value;
  listeners.forEach((l) => l());
}

export function hasSessionCookie(cookie: string): boolean {
  return AUTH_COOKIE.test(cookie);
}

function check(): Promise<void> {
  if (checking) return checking;
  checking = (async () => {
    try {
      if (!isSupabaseConfigured() || !hasSessionCookie(document.cookie)) {
        set(false);
        return;
      }
      const { createClient } = await import("@/utils/supabase/client");
      const { data } = await createClient().auth.getSession();
      set(Boolean(data.session));
    } catch {
      set(false);
    } finally {
      checking = null;
    }
  })();
  return checking;
}

function onFocus() {
  // Signed out in another tab: the cookie is gone, and the links go with it.
  if (signedIn && !hasSessionCookie(document.cookie)) set(false);
  else if (!signedIn && hasSessionCookie(document.cookie)) void check();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void check();
    window.addEventListener("focus", onFocus);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("focus", onFocus);
  };
}

/** False on the server and on the first paint, so the HTML is the same for everyone. */
export function useSignedIn(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => signedIn,
    () => false,
  );
}
