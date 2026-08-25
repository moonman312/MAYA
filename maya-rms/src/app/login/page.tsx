"use client";

import { createClient } from "@/utils/supabase/client";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Mode = "signin" | "signup";

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

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") === "signup") {
      setMode("signup");
    }
  }, []);

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
                {mode === "signin"
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
