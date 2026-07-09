"use client";

import { createClient } from "@/utils/supabase/client";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from "react";

type Stage = "checking" | "ready" | "session-error" | "complete";

function AcceptInviteFallback() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div className="w-full space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-2xl font-semibold">Set your password</h1>
          <p className="text-sm text-slate-400">Verifying your invite…</p>
        </div>
      </div>
    </main>
  );
}

function AcceptInviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const configured = useMemo(() => isSupabaseConfigured(), []);
  const [stage, setStage] = useState<Stage>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const exchangeCode = useCallback(async () => {
    if (!configured) return;
    const code = searchParams.get("code");
    const supabase = createClient();

    if (code) {
      const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
      if (exErr) {
        setError(exErr.message);
        setStage("session-error");
        return;
      }
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setStage("session-error");
      setError("No session. The invite link may have expired.");
      return;
    }
    setStage("ready");
  }, [configured, searchParams]);

  useEffect(() => {
    void exchangeCode();
  }, [exchangeCode]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const updates: {
        password: string;
        data?: Record<string, unknown>;
      } = { password };
      if (fullName.trim()) updates.data = { full_name: fullName.trim() };

      const { error: updErr } = await supabase.auth.updateUser(updates);
      if (updErr) {
        setError(updErr.message);
        return;
      }
      setStage("complete");
      setMessage("Password set. Redirecting to the app…");
      setTimeout(() => {
        router.replace("/");
        router.refresh();
      }, 1200);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div className="w-full space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-2xl font-semibold">Set your password</h1>
          <p className="text-sm text-slate-300">
            Welcome to MAYA. Set a password to finish accepting your invite.
          </p>

          {!configured && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              Server configuration is incomplete. Contact your administrator.
            </div>
          )}

          {stage === "checking" && (
            <p className="text-sm text-slate-400">Verifying your invite…</p>
          )}

          {stage === "session-error" && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
              {error ?? "The invite link is invalid or expired. Ask an administrator to resend."}
            </div>
          )}

          {stage === "ready" && (
            <form onSubmit={onSubmit} className="space-y-3">
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                Full name (optional)
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="mt-1 w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                />
              </label>
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="mt-1 w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                />
              </label>
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                Confirm password
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="mt-1 w-full rounded bg-slate-950 p-2 text-sm text-slate-100"
                />
              </label>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-60"
              >
                {loading ? "Setting password…" : "Set password & continue"}
              </button>
              {error && <p className="text-sm text-rose-300">{error}</p>}
            </form>
          )}

          {stage === "complete" && (
            <p className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
              {message}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<AcceptInviteFallback />}>
      <AcceptInviteContent />
    </Suspense>
  );
}
