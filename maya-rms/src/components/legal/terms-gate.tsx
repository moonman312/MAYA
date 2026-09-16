"use client";

import { MayaLockup } from "@/components/brand/logo";
import { TermsConsent } from "@/components/legal/terms-consent";
import { isAcceptanceExemptPath, PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal/versions";
import { usePathname } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

/**
 * Fired by a screen whose server call answered reason "terms_required" (the
 * checkout route does), so the accept screen shows even though its own check
 * on page load let the person through. TERMS_ACCEPTED_EVENT follows once they
 * accept, so that screen can pick up where it stopped.
 */
export const TERMS_REQUIRED_EVENT = "maya:terms-required";
export const TERMS_ACCEPTED_EVENT = "maya:terms-accepted";

export function askForTerms() {
  window.dispatchEvent(new Event(TERMS_REQUIRED_EVENT));
}

/**
 * Asks a signed-in person who has not accepted the current Terms of Service
 * and Privacy Policy to accept them, once, over whatever page they opened.
 * When they do, it gets out of the way and they are exactly where they were
 * going; nothing navigates.
 *
 * Mounted once in the root layout. It is a covering screen rather than a
 * redirect because the layout never re-renders on navigation and cannot see
 * the path, and because a redirect would need a way back that every page
 * would have to honour.
 *
 * Silent unless the server positively says acceptance is required. Any
 * failure to find out leaves the app usable: see /api/legal/acceptance.
 */
export function TermsGate() {
  const pathname = usePathname();
  const exempt = isAcceptanceExemptPath(pathname);
  const [required, setRequired] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false);
  const arrivedFromExempt = useRef(true);

  useEffect(() => {
    if (exempt) {
      arrivedFromExempt.current = true;
      return;
    }
    // Signing in, signing up and accepting an invite all happen on exempt
    // pages, so leaving one is when a different person may now hold the
    // session. Otherwise one answer per page load is enough.
    if (settled.current && !arrivedFromExempt.current) return;
    arrivedFromExempt.current = false;

    let alive = true;
    fetch("/api/legal/acceptance", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { required?: boolean } | null) => {
        if (!alive || !body) return;
        const needed = body.required === true;
        settled.current = !needed;
        setRequired(needed);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [exempt, pathname]);

  // The server has positively said so, so no second fetch: that fetch fails
  // open, and is how this person got past the screen in the first place.
  useEffect(() => {
    const onRequired = () => {
      settled.current = false;
      setRequired(true);
    };
    window.addEventListener(TERMS_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(TERMS_REQUIRED_EVENT, onRequired);
  }, []);

  async function onAccept(e: FormEvent) {
    e.preventDefault();
    if (!agreed) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/legal/acceptance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accepted: true,
          context: "reaccept",
          termsVersion: TERMS_VERSION,
          privacyVersion: PRIVACY_VERSION,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "We couldn't save that just now. Please try again.");
        return;
      }
      settled.current = true;
      setRequired(false);
      window.dispatchEvent(new Event(TERMS_ACCEPTED_EVENT));
    } catch {
      setError("We couldn't save that just now. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!required || exempt) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="terms-gate-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-slate-950 p-6 text-slate-100"
    >
      <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-900 p-6">
        <MayaLockup height={32} className="mb-6" />
        <h1 id="terms-gate-title" className="text-2xl font-semibold">
          Before you continue
        </h1>
        <form className="mt-5 space-y-4" onSubmit={onAccept}>
          <TermsConsent checked={agreed} onChange={setAgreed} disabled={saving} />
          <button
            type="submit"
            disabled={!agreed || saving}
            className="w-full cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving..." : "Continue"}
          </button>
        </form>
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
        <form action="/auth/logout" method="post" className="mt-4">
          <button type="submit" className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
