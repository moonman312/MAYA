"use client";

import { GOD_MODE_CHANGED_EVENT } from "@/components/admin/god-mode-banner";
import { createClient } from "@/utils/supabase/client";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type Step = "loading" | "enroll" | "verify";

/** The name the authenticator shows for the code. */
const FACTOR_NAME = "MAYA God Mode";

/** Supabase Auth's MFA errors, in the words the person at the keyboard needs. */
export function plainMfaError(message: string | undefined): string {
  const m = message ?? "";
  if (/invalid|incorrect|expired/i.test(m) && /code|totp|challenge/i.test(m)) {
    return "That code didn't work. Try the next one from your authenticator app.";
  }
  if (/mfa|factor/i.test(m) && /disabled|not enabled|unsupported|not allowed/i.test(m)) {
    return "Authenticator codes aren't switched on for this project yet. In Supabase, turn on Authentication, Multi-Factor Authentication, TOTP.";
  }
  if (/friendly name/i.test(m)) {
    return "An authenticator called MAYA God Mode already exists on this login. Remove it in Supabase and try again.";
  }
  return m || "Something went wrong. Try again.";
}

/**
 * The big red button. Pressing it asks for a code from the admin's
 * authenticator app (enrolling one first, with a QR code, when the login has
 * none), which raises the session to aal2, then asks the server to open a
 * God Mode window. The database checks both; this only collects the code.
 */
export function GodModeButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setOpen(true);
    setStep("loading");
    setError(null);
    setCode("");
    setQr(null);
    setSecret(null);
    try {
      const supabase = createClient();
      const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) {
        setError(plainMfaError(listErr.message));
        return;
      }
      const verified = factors?.totp ?? [];
      if (verified.length > 0) {
        setFactorId(verified[0].id);
        setStep("verify");
        return;
      }
      // An enrolment abandoned halfway leaves an unverified factor behind, and
      // a second enrolment under the same name is refused; clear it first.
      for (const f of factors?.all ?? []) {
        if (f.factor_type === "totp" && f.status === "unverified") {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }
      const { data: enrolled, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: FACTOR_NAME,
        issuer: "MAYA",
      });
      if (enrollErr || !enrolled) {
        setError(plainMfaError(enrollErr?.message));
        return;
      }
      setFactorId(enrolled.id);
      setQr(enrolled.totp.qr_code);
      setSecret(enrolled.totp.secret);
      setStep("enroll");
    } catch (e) {
      setError(plainMfaError(e instanceof Error ? e.message : undefined));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!factorId || busy) return;
    const digits = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(digits)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: digits });
      if (verifyErr) {
        setError(plainMfaError(verifyErr.message));
        return;
      }
      // The session is aal2 now and the auth cookie has been rewritten, so the
      // server's call carries it.
      const res = await fetch("/api/admin/god-mode", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not turn on God Mode. Try again.");
        return;
      }
      setOpen(false);
      window.dispatchEvent(new Event(GOD_MODE_CHANGED_EVENT));
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void start()}
        className={`cursor-pointer rounded bg-red-600 font-bold uppercase tracking-widest text-white shadow hover:bg-red-500 ${
          compact ? "px-3 py-1.5 text-xs" : "px-5 py-3 text-base"
        }`}
      >
        God Mode
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="god-mode-title"
          className="fixed inset-0 z-[950] flex items-center justify-center overflow-y-auto bg-slate-950/80 p-6 text-slate-100"
        >
          <div className="w-full max-w-md rounded-lg border border-red-500/40 bg-slate-900 p-6">
            <h2 id="god-mode-title" className="text-xl font-semibold text-red-300">
              God Mode
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Turning this on lets you change any property for a short window. Every change is
              recorded, and shows in the property&apos;s change log as made by MAYA support.
            </p>

            {step === "loading" && !error ? (
              <p className="mt-4 text-sm text-slate-400">Checking your authenticator...</p>
            ) : null}

            {step !== "loading" ? (
              <form className="mt-4 space-y-4" onSubmit={submit}>
                {step === "enroll" ? (
                  <div className="space-y-3">
                    <p className="text-sm text-slate-300">
                      Scan this with your authenticator app, then enter the 6-digit code it shows.
                    </p>
                    {qr ? (
                      // A data: SVG straight from Supabase Auth: nothing for next/image to fetch or optimise.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={qr}
                        alt="QR code for your authenticator app"
                        className="h-44 w-44 rounded bg-white p-2"
                      />
                    ) : null}
                    {secret ? (
                      <p className="text-xs text-slate-400">
                        Or type this key into the app: <code className="select-all break-all text-slate-200">{secret}</code>
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-slate-300">Enter the 6-digit code from your authenticator app.</p>
                )}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  aria-label="Authenticator code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoFocus
                  className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-center text-lg tracking-[0.4em] text-slate-100"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="cursor-pointer rounded border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="cursor-pointer rounded bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? "Checking..." : "Turn on God Mode"}
                  </button>
                </div>
              </form>
            ) : null}

            {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
            {step === "loading" && error ? (
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="mt-3 cursor-pointer rounded border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Close
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
