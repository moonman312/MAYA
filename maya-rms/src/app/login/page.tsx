"use client";

import { createClient } from "@/utils/supabase/client";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const configured = useMemo(() => isSupabaseConfigured(), []);

  async function onSignIn(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
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

  async function onSignUp() {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const supabase = createClient();
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });
      if (signUpError) {
        setError(signUpError.message);
        return;
      }
      setMessage("Account created. If email confirmation is enabled, confirm your email then sign in.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div className="w-full rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-2xl font-semibold">Sign in to MAYA RMS</h1>
          <p className="mt-2 text-sm text-slate-300">
            Sign in with your account. Hotel access is assigned by an administrator.
          </p>

          {!configured && (
            <div className="mt-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              Server configuration is incomplete. Check environment variables for this app.
            </div>
          )}

          <form className="mt-5 space-y-3" onSubmit={onSignIn}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="Email"
              className="w-full rounded bg-slate-950 p-2 text-sm"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Password"
              className="w-full rounded bg-slate-950 p-2 text-sm"
            />
            <button
              type="submit"
              disabled={loading || !configured}
              className="w-full cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Working..." : "Sign In"}
            </button>
          </form>

          <button
            type="button"
            onClick={onSignUp}
            disabled={loading || !configured}
            className="mt-3 w-full cursor-pointer rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Create Account
          </button>

          {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
          {message && <p className="mt-3 text-sm text-emerald-300">{message}</p>}

          <p className="mt-4 text-xs text-slate-400">
            New users need a hotel membership before the dashboard shows property data.
          </p>
          <p className="mt-2 text-xs text-slate-400">
            <Link href="/" className="cursor-pointer text-sky-300 hover:underline">
              Back to app
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
