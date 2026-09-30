"use client";

import { MayaLockup } from "@/components/brand/logo";
import { TermsConsent } from "@/components/legal/terms-consent";
import {
  isEmailNotConfirmed,
  isRateLimited,
  linkRefusedInUrl,
  RESEND_COOLDOWN_MS,
  RESET_PAUSE_MS,
} from "@/lib/auth-links";
import { signupAcceptanceMetadata } from "@/lib/legal/versions";
import { safeNext } from "@/lib/deep-links";
import { forgetClaimTicket, readClaimTicket, saveClaimTicket } from "@/lib/pms/claim-ticket";
import { syncTextSizeFromProfile } from "@/lib/text-size";
import { createClient } from "@/utils/supabase/client";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

type Mode = "signin" | "signup" | "forgot";

const CONFIRMED = "Your email is confirmed. Sign in to continue.";
const LINK_USED = "That link has expired or was already used. Try signing in.";

/**
 * Where the confirmation email's link comes back to. Supabase confirms the
 * address on its own page first, then sends the browser here with a one-time
 * code (or with error_code when the link had run out).
 */
function confirmationRedirect() {
  return `${window.location.origin}/login?confirmed=1`;
}

/** What that return trip can leave in the address. All of it is cleared once read. */
const LANDING_PARAMS = ["code", "confirmed", "error", "error_code", "error_description"];

/**
 * Where a link into MAYA (/go/...) waits while someone signs in, so it
 * survives an email confirmation too. Only /go links are ever kept (safeNext),
 * and only for half an hour.
 */
const NEXT_KEY = "maya.go.next";
const NEXT_TTL_MS = 30 * 60 * 1000;

function readStoredNext(): string | null {
  try {
    const raw = sessionStorage.getItem(NEXT_KEY);
    if (!raw) return null;
    const { next, at } = JSON.parse(raw) as { next?: unknown; at?: unknown };
    if (typeof at !== "number" || Date.now() - at > NEXT_TTL_MS) {
      sessionStorage.removeItem(NEXT_KEY);
      return null;
    }
    return safeNext(next);
  } catch {
    return null;
  }
}

function forgetNext() {
  try {
    sessionStorage.removeItem(NEXT_KEY);
  } catch {
    // nothing stored
  }
}

/**
 * One card, two doors. Sign-in is the default; the signup mode is its own
 * form that asks a new owner to SET a password rather than assuming one
 * exists — most arrivals come from a waitlist invite and have never had one.
 * Invite emails can deep-link straight to it with ?mode=signup.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const configured = useMemo(() => isSupabaseConfigured(), []);

  const [claim, setClaim] = useState<string | null>(null);
  const [reconnected, setReconnected] = useState(false);
  const [next, setNext] = useState<string | null>(null);

  // "Send the link again", on the check-email screen and after a sign-in that
  // was refused for an unconfirmed address.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [coolingDown, setCoolingDown] = useState(false);
  const coolTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One redemption per code, however many times the effect runs (Strict Mode
  // runs it twice in development).
  const redeemed = useRef(false);

  useEffect(
    () => () => {
      if (coolTimer.current) clearTimeout(coolTimer.current);
    },
    [],
  );

  /** The confirmation link's code: redeem it, then carry on as a sign-in would. */
  const redeem = useEffectEvent(
    async (code: string, claimToken: string | null, going: string | null) => {
      setLoading(true);
      try {
        const supabase = createClient();
        const { data: session, error: exErr } = await supabase.auth.exchangeCodeForSession(code);
        // The address is confirmed by the time Supabase sends anyone here, so
        // a code this browser can't redeem (opened on another device, say)
        // still only needs a password.
        if (exErr) {
          setNotice(CONFIRMED);
          return;
        }
        // Their text size, on this browser before the first page.
        await syncTextSizeFromProfile(supabase, session?.user?.id ?? null);
        if (!(await finishClaim(claimToken))) return;
        afterSignIn(claimToken, going);
      } catch {
        setNotice(CONFIRMED);
      } finally {
        setLoading(false);
      }
    },
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    const q = url.searchParams;

    // Back from the confirmation email. What it brought is read, then taken
    // out of the address before any Supabase client is made: the browser
    // client redeems a code it finds there by itself as it starts, and this
    // page could then not tell a redeemed code from a refused one. A one-time
    // link has no business in the history either.
    const code = q.get("code");
    const refused = linkRefusedInUrl(url.href);
    const landed = q.get("confirmed") === "1" || Boolean(code) || refused;
    if (landed) {
      for (const key of LANDING_PARAMS) q.delete(key);
      window.history.replaceState(window.history.state, "", url.pathname + url.search);
    }

    if (q.get("mode") === "signup") setMode("signup");
    // The reset page sends people back here for a fresh link.
    if (q.get("mode") === "forgot") setMode("forgot");
    // Flow A: Cloudbeds sent them here after they connected in the Marketplace.
    // A claim ticket means the property is parked and waiting for an owner; a
    // reconnect means it already has one and just needs signing in.
    // The ticket is kept in this browser (claim-ticket.ts) because the
    // confirmation link comes back to /login without it, often in a new tab.
    // Without it the property would be parked until it expired, and the owner
    // would have no way to reach it.
    const fromUrl = q.get("claim");
    if (fromUrl) saveClaimTicket(fromUrl);
    const c = fromUrl ?? readClaimTicket();
    if (c) {
      setClaim(c);
      setMode(fromUrl ? "signup" : "signin");
    }
    setReconnected(q.get("reconnected") === "1");

    // A link into MAYA sent them here to sign in first. Only MAYA's own /go
    // links are followed; anything else is ignored and the page works as ever.
    const fromLink = safeNext(q.get("next"));
    const going = fromLink ?? readStoredNext();
    if (going) {
      setNext(going);
      try {
        sessionStorage.setItem(NEXT_KEY, JSON.stringify({ next: going, at: Date.now() }));
      } catch {
        // Private browsing: the URL parameter still covers the direct path.
      }
      // Already signed in (in another tab, say): go straight on.
      if (fromLink && !c && !landed && configured) {
        void createClient()
          .auth.getSession()
          .then(({ data }) => {
            if (data.session) {
              forgetNext();
              window.location.assign(going);
            }
          });
      }
    }

    if (landed) {
      setMode("signin");
      if (refused) {
        setNotice(LINK_USED);
      } else if (code && configured) {
        if (!redeemed.current) {
          redeemed.current = true;
          void redeem(code, c, going);
        }
      } else {
        setNotice(CONFIRMED);
      }
    }
  }, [configured]);

  /** Where to go once signed in: a claim still wins, then a link, then home. */
  function afterSignIn(claimToken = claim, going = next) {
    if (claimToken) {
      router.replace("/onboarding");
      router.refresh();
      return;
    }
    if (going) {
      forgetNext();
      // A full navigation, so /go (a route handler) runs on the server.
      window.location.assign(going);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  /** Attach the Marketplace property to the account that just authenticated. */
  async function finishClaim(claimToken = claim): Promise<boolean> {
    if (!claimToken) return true;
    const res = await fetch("/api/pms/marketplace/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: claimToken }),
    });
    if (res.ok) {
      forgetClaimTicket();
      return true;
    }
    // Expired, not valid, or someone else's: the ticket can never work, so
    // this browser stops offering it to every sign-in. A failure that may pass
    // (5xx, no session yet) keeps it for another go.
    if (res.status === 400 || res.status === 409) forgetClaimTicket();
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? "Could not finish connecting your property.");
    return false;
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setUnconfirmed(false);
    setResendNote(null);
    setPassword("");
    setConfirm("");
    setAgreed(false);
  }

  /** Supabase allows one confirmation email a minute per address. */
  function coolDown() {
    setCoolingDown(true);
    if (coolTimer.current) clearTimeout(coolTimer.current);
    coolTimer.current = setTimeout(() => setCoolingDown(false), RESEND_COOLDOWN_MS);
  }

  async function sendAgain(address: string) {
    if (coolingDown || resending) return;
    setResending(true);
    setResendNote(null);
    try {
      const { error: resendError } = await createClient().auth.resend({
        type: "signup",
        email: address,
        options: { emailRedirectTo: confirmationRedirect() },
      });
      if (resendError) {
        if (isRateLimited(resendError)) {
          coolDown();
          setResendNote({ ok: false, text: "Too many emails for now. Wait a minute, then try again." });
        } else {
          setResendNote({ ok: false, text: "Could not send the link. Try again in a moment." });
        }
        return;
      }
      coolDown();
      setResendNote({ ok: true, text: "Sent. Check your inbox." });
    } catch {
      setResendNote({ ok: false, text: "Could not send the link. Try again in a moment." });
    } finally {
      setResending(false);
    }
  }

  async function onSignIn(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    setUnconfirmed(false);
    setResendNote(null);
    try {
      const supabase = createClient();
      const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        if (isEmailNotConfirmed(signInError)) setUnconfirmed(true);
        else setError(signInError.message);
        return;
      }
      // Their text size, on this browser before the first page after sign-in.
      await syncTextSizeFromProfile(supabase, signedIn?.user?.id ?? null);
      if (!(await finishClaim())) return;
      afterSignIn();
    } finally {
      setLoading(false);
    }
  }

  async function onForgot(e: FormEvent) {
    e.preventDefault();
    const address = email.trim();
    setLoading(true);
    setError(null);
    try {
      // Fired and never awaited: see RESET_PAUSE_MS. The link comes back to
      // this site's own reset page, never to an address from the request.
      void createClient()
        .auth.resetPasswordForEmail(address, {
          redirectTo: `${window.location.origin}/auth/reset-password`,
        })
        .catch(() => {});
    } catch {
      // Same screen either way.
    }
    await new Promise((resolve) => setTimeout(resolve, RESET_PAUSE_MS));
    setLoading(false);
    setResetSentTo(address);
  }

  async function onSignUp(e: FormEvent) {
    e.preventDefault();
    if (!agreed) return;
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      // The tick rides in the user metadata because a confirmation email may
      // stand between this form and any session: the database records it as
      // the user is created, so nothing depends on them ever coming back.
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: signupAcceptanceMetadata(claim ? "claim" : "signup", navigator.userAgent),
          emailRedirectTo: confirmationRedirect(),
        },
      });
      if (signUpError) {
        setError(signUpError.message);
        return;
      }
      // Supabase answers an already-registered email with a userless success
      // instead of an error, so enumeration stays impossible — an empty
      // identities list is how that case is recognized.
      if (data.user && (data.user.identities?.length ?? 0) === 0) {
        switchMode("signin");
        setError("That email already has an account. Sign in instead.");
        return;
      }
      if (data.session) {
        if (!(await finishClaim())) return;
        // A property that just arrived from the Marketplace is owned now but
        // not paid for. /onboarding is the router: it lands them on payment,
        // and once the subscription is in, on the import already running.
        afterSignIn();
        return;
      }
      // The confirmation email just went out, which starts Supabase's minute.
      coolDown();
      setResendNote(null);
      setSentTo(email);
    } finally {
      setLoading(false);
    }
  }

  const inputClass = "w-full rounded bg-slate-950 p-2 text-sm";
  const primaryClass =
    "w-full cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60";

  function sendAgainButton(address: string) {
    return (
      <>
        <button
          type="button"
          onClick={() => void sendAgain(address)}
          disabled={coolingDown || resending || !configured}
          className="cursor-pointer text-sm text-sky-300 hover:underline disabled:cursor-not-allowed disabled:text-slate-500 disabled:no-underline"
        >
          {resending ? "Sending..." : "Send the link again"}
        </button>
        {resendNote && (
          <p
            role="status"
            className={`mt-1 text-sm ${resendNote.ok ? "text-emerald-300" : "text-rose-300"}`}
          >
            {resendNote.text}
          </p>
        )}
      </>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div className="w-full rounded-lg border border-slate-800 bg-slate-900 p-6">
          <MayaLockup height={32} className="mb-6" />
          {resetSentTo ? (
            <>
              <h1 className="text-2xl font-semibold">Check your email</h1>
              <p className="mt-2 text-sm text-slate-300">
                If <span className="font-medium text-slate-100">{resetSentTo}</span> has a MAYA
                account, a link to set a new password is on its way. Open it in this browser. The
                link works once.
              </p>
              <button
                type="button"
                onClick={() => {
                  setResetSentTo(null);
                  switchMode("signin");
                }}
                className={`mt-5 ${primaryClass}`}
              >
                Back to sign in
              </button>
            </>
          ) : sentTo ? (
            <>
              <h1 className="text-2xl font-semibold">Check your email</h1>
              <p className="mt-2 text-sm text-slate-300">
                A confirmation link is on its way to{" "}
                <span className="font-medium text-slate-100">{sentTo}</span>. Open it to finish
                signing up.
                {claim ? " Your Cloudbeds property is saved and will be waiting." : ""}
              </p>
              <div className="mt-4">{sendAgainButton(sentTo)}</div>
              <button
                type="button"
                onClick={() => {
                  setSentTo(null);
                  switchMode("signin");
                }}
                className={`mt-5 ${primaryClass}`}
              >
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold">
                {mode === "signin"
                  ? "Sign in to MAYA"
                  : mode === "forgot"
                    ? "Reset your password"
                    : "Create your MAYA account"}
              </h1>
              <p className="mt-2 text-sm text-slate-300">
                {mode === "forgot"
                  ? "Type the email you sign in with, and we'll send you a link to set a new password."
                  : claim
                    ? mode === "signin"
                      ? "Your Cloudbeds property is connected. Sign in to finish setting it up."
                      : "Your Cloudbeds property is connected. Create your account to finish setting it up."
                    : reconnected
                      ? "Your Cloudbeds connection is active again. Sign in to pick up where you left off."
                      : mode === "signin"
                        ? "Welcome back."
                        : "Set a password and you're on your way. Your property comes next."}
              </p>

              {!configured && (
                <div className="mt-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                  Server configuration is incomplete. Check environment variables for this app.
                </div>
              )}

              {notice && (
                <p
                  role="status"
                  className="mt-4 rounded border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-sky-200"
                >
                  {notice}
                </p>
              )}

              {mode === "signin" ? (
                <form className="mt-5 space-y-3" onSubmit={onSignIn}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="Email"
                    autoComplete="email"
                    className={inputClass}
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="Password"
                    autoComplete="current-password"
                    className={inputClass}
                  />
                  <button type="submit" disabled={loading || !configured} className={primaryClass}>
                    {loading ? "Working..." : "Sign In"}
                  </button>
                  <p className="text-right text-sm">
                    <button
                      type="button"
                      onClick={() => switchMode("forgot")}
                      className="cursor-pointer text-sky-300 hover:underline"
                    >
                      Forgot password?
                    </button>
                  </p>
                </form>
              ) : mode === "forgot" ? (
                <form className="mt-5 space-y-3" onSubmit={onForgot}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="Email"
                    autoComplete="email"
                    className={inputClass}
                  />
                  <button type="submit" disabled={loading || !configured} className={primaryClass}>
                    {loading ? "Sending..." : "Send reset link"}
                  </button>
                </form>
              ) : (
                <form className="mt-5 space-y-3" onSubmit={onSignUp}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="Email"
                    autoComplete="email"
                    className={inputClass}
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    placeholder="Choose a password"
                    autoComplete="new-password"
                    className={inputClass}
                  />
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    placeholder="Confirm password"
                    autoComplete="new-password"
                    className={inputClass}
                  />
                  <TermsConsent checked={agreed} onChange={setAgreed} disabled={loading} />
                  <button
                    type="submit"
                    disabled={loading || !configured || !agreed}
                    className={primaryClass}
                  >
                    {loading ? "Working..." : "Create Account"}
                  </button>
                </form>
              )}

              {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}

              {unconfirmed && mode === "signin" && (
                <div className="mt-3">
                  <p className="text-sm text-amber-200">
                    Confirm your email first. The link is in your inbox.
                  </p>
                  <div className="mt-1">{sendAgainButton(email.trim())}</div>
                </div>
              )}

              <p className="mt-4 text-sm text-slate-400">
                {mode === "forgot" ? (
                  <>
                    Remembered it?{" "}
                    <button
                      type="button"
                      onClick={() => switchMode("signin")}
                      className="cursor-pointer text-sky-300 hover:underline"
                    >
                      Sign in
                    </button>
                  </>
                ) : mode === "signin" ? (
                  <>
                    New to MAYA?{" "}
                    <button
                      type="button"
                      onClick={() => switchMode("signup")}
                      className="cursor-pointer text-sky-300 hover:underline"
                    >
                      Create your account
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{" "}
                    <button
                      type="button"
                      onClick={() => switchMode("signin")}
                      className="cursor-pointer text-sky-300 hover:underline"
                    >
                      Sign in
                    </button>
                  </>
                )}
              </p>

              {!configured && (
                <p className="mt-2 text-xs text-slate-400">
                  <Link href="/" className="cursor-pointer text-sky-300 hover:underline">
                    Back to app
                  </Link>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
