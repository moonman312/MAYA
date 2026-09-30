"use client";

import { MayaLockup } from "@/components/brand/logo";
import { linkProblem, linkRefusedInUrl, type LinkProblem } from "@/lib/auth-links";
import { syncTextSizeFromProfile } from "@/lib/text-size";
import { createClient } from "@/utils/supabase/client";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { isAuthError } from "@supabase/supabase-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Stage = "checking" | "ready" | "link-error" | "complete";

/**
 * Where the link from "Forgot password?" lands: redeem it, then set a new
 * password.
 *
 * Two kinds of link can arrive, and each is redeemed the way the invitation
 * page redeems its own:
 *   token_hash  The reset email template links here with {{ .TokenHash }}.
 *               verifyOtp redeems it in any browser.
 *   code        Supabase's default template goes through its own verify page,
 *               which sends a PKCE code here. Only the browser that asked for
 *               the reset holds the other half of it.
 *
 * Both are taken out of the address before the Supabase client is first made.
 * That keeps a one-time link out of the history, and it matters for the code:
 * the browser client redeems a code it finds in the address by itself as it
 * starts, after which this page could not tell a redeemed code from a refused
 * one. With the address clean there is one redemption, here, and its answer is
 * the one the page reads.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const configured = useMemo(() => isSupabaseConfigured(), []);
  const [stage, setStage] = useState<Stage>("checking");
  const [problem, setProblem] = useState<LinkProblem>("expired");
  const [account, setAccount] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!configured || started.current) return;
    started.current = true;

    const url = new URL(window.location.href);
    const tokenHash = url.searchParams.get("token_hash");
    const code = url.searchParams.get("code");
    const refused = linkRefusedInUrl(url.href);
    window.history.replaceState(window.history.state, "", url.pathname);

    function refuse(why: LinkProblem) {
      setProblem(why);
      setStage("link-error");
    }

    async function redeem() {
      if (refused || (!tokenHash && !code)) return refuse("expired");
      const supabase = createClient();
      if (tokenHash) {
        // As on the invitation page: whoever was signed in on this browser is
        // signed out first, so the new password lands on the link's account.
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session) await supabase.auth.signOut({ scope: "local" });
        const { error: otpErr } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "recovery",
        });
        if (otpErr) return refuse(linkProblem(otpErr));
      } else if (code) {
        // Not signed out first: signing out throws away the half of the code
        // this browser kept. A successful exchange replaces any session anyway.
        const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
        if (exErr) return refuse(linkProblem(exErr));
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return refuse("expired");
      // Their text size, on this browser before the app opens.
      await syncTextSizeFromProfile(supabase, user.id);
      setAccount(user.email ?? null);
      setStage("ready");
    }

    redeem().catch(() => refuse("retry"));
  }, [configured]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
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
      const { error: updErr } = await createClient().auth.updateUser({ password });
      if (updErr) {
        setError(passwordRefusal(updErr));
        return;
      }
      setStage("complete");
      setTimeout(() => {
        router.replace("/");
        router.refresh();
      }, 1200);
    } catch {
      setError(passwordRefusal(null));
    } finally {
      setLoading(false);
    }
  }

  const linkClass = "underline hover:text-rose-100";
  const labelClass = "block text-xs uppercase tracking-wide text-slate-400";
  const inputClass = "mt-1 w-full rounded bg-slate-950 p-2 text-sm text-slate-100";

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div className="w-full space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-6">
          <MayaLockup height={32} className="mb-6" />
          <h1 className="text-2xl font-semibold">Set a new password</h1>

          {!configured && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              Server configuration is incomplete. Check environment variables for this app.
            </div>
          )}

          {configured && stage === "checking" && (
            <p className="text-sm text-slate-400">Checking your link…</p>
          )}

          {stage === "link-error" && (
            <div
              role="alert"
              className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200"
            >
              {problem === "retry" ? (
                "We couldn't check this link just now. Reload the page to try again."
              ) : problem === "other-browser" ? (
                <>
                  Open this link in the browser where you asked for it. Or{" "}
                  <Link href="/login?mode=forgot" className={linkClass}>
                    ask for a new link
                  </Link>{" "}
                  from this one.
                </>
              ) : (
                <>
                  This link has expired or was already used. If you set your new password
                  already,{" "}
                  <Link href="/login" className={linkClass}>
                    sign in
                  </Link>
                  . If not,{" "}
                  <Link href="/login?mode=forgot" className={linkClass}>
                    ask for a new link
                  </Link>
                  .
                </>
              )}
            </div>
          )}

          {stage === "ready" && (
            <form onSubmit={onSubmit} className="space-y-3">
              <p className="text-sm text-slate-300">
                {account ? (
                  <>
                    Choose a new password for{" "}
                    <span className="font-medium text-slate-100">{account}</span>.
                  </>
                ) : (
                  "Choose a new password."
                )}
              </p>
              <label className={labelClass}>
                New password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                Confirm new password
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className={inputClass}
                />
              </label>
              <button
                type="submit"
                disabled={loading}
                className="w-full cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Saving…" : "Save new password"}
              </button>
              {error && <p className="text-sm text-rose-300">{error}</p>}
            </form>
          )}

          {stage === "complete" && (
            <p className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
              Your new password is set. Taking you to MAYA…
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

/** Supabase's reasons, in words for the person holding the form. */
function passwordRefusal(err: unknown): string {
  const code = isAuthError(err) ? err.code : undefined;
  if (code === "same_password") return "That's the password you have now. Choose a different one.";
  if (code === "weak_password") return "That password is too easy to guess. Choose a different one.";
  return "Could not save your new password. Try again, or ask for a new link from the sign-in page.";
}
