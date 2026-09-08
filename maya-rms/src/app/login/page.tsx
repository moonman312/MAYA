"use client";

import { createClient } from "@/utils/supabase/client";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Mode = "signin" | "signup";

/** Where a Flow A claim ticket waits out an email-confirmation round trip. */
const CLAIM_KEY = "maya.marketplace.claim";

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
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const configured = useMemo(() => isSupabaseConfigured(), []);

  const [claim, setClaim] = useState<string | null>(null);
  const [reconnected, setReconnected] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("mode") === "signup") setMode("signup");
    // Flow A: Cloudbeds sent them here after they connected in the Marketplace.
    // A claim ticket means the property is parked and waiting for an owner; a
    // reconnect means it already has one and just needs signing in.
    // Survives the round trip through an email confirmation link, which comes
    // back to /login with no query string — without this the property would be
    // parked forever and the owner would have no way to reach it.
    const c = q.get("claim") ?? sessionStorage.getItem(CLAIM_KEY);
    if (c) {
      setClaim(c);
      setMode(q.get("claim") ? "signup" : "signin");
      try {
        sessionStorage.setItem(CLAIM_KEY, c);
      } catch {
        // Private browsing: the URL parameter still covers the direct path.
      }
    }
    setReconnected(q.get("reconnected") === "1");
  }, []);

  /** Attach the Marketplace property to the account that just authenticated. */
  async function finishClaim(): Promise<boolean> {
    if (!claim) return true;
    const res = await fetch("/api/pms/marketplace/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: claim }),
    });
    if (res.ok) {
      try {
        sessionStorage.removeItem(CLAIM_KEY);
      } catch {
        // Nothing to clean up if storage was unavailable to begin with.
      }
      return true;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? "Could not finish connecting your property.");
    return false;
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirm("");
  }

  async function onSignIn(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      if (!(await finishClaim())) return;
      router.replace("/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  async function onSignUp(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
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
        setError("That email already has an account — sign in instead.");
        return;
      }
      if (data.session) {
        if (!(await finishClaim())) return;
        router.replace("/");
        router.refresh();
        return;
      }
      setSentTo(email);
    } finally {
      setLoading(false);
    }
  }

  const inputClass = "w-full rounded bg-slate-950 p-2 text-sm";
  const primaryClass =
    "w-full cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div className="w-full rounded-lg border border-slate-800 bg-slate-900 p-6">
          {sentTo ? (
            <>
              <h1 className="text-2xl font-semibold">Check your email</h1>
              <p className="mt-2 text-sm text-slate-300">
                A confirmation link is on its way to{" "}
                <span className="font-medium text-slate-100">{sentTo}</span>. Open it, then come
                back and sign in.
                {claim ? " Your Cloudbeds property is saved and will be waiting." : ""}
              </p>
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
                {mode === "signin" ? "Sign in to MAYA" : "Create your MAYA account"}
              </h1>
              <p className="mt-2 text-sm text-slate-300">
                {claim
                  ? "Your Cloudbeds property is connected. Create your account to finish setting it up."
                  : reconnected
                    ? "Your Cloudbeds connection is active again. Sign in to pick up where you left off."
                    : mode === "signin"
                      ? "Welcome back."
                      : "Set a password and you're on your way — your property comes next."}
              </p>

              {!configured && (
                <div className="mt-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                  Server configuration is incomplete. Check environment variables for this app.
                </div>
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
                  <button type="submit" disabled={loading || !configured} className={primaryClass}>
                    {loading ? "Working..." : "Create Account"}
                  </button>
                </form>
              )}

              {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}

              <p className="mt-4 text-sm text-slate-400">
                {mode === "signin" ? (
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
