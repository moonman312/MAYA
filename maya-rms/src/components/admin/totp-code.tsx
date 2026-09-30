"use client";

import { createClient } from "@/utils/supabase/client";
import { useState } from "react";

/**
 * A code from an authenticator app, shared by the God Mode button and the
 * staff code step (/admin-code). The first time, it enrols an authenticator
 * (a QR code and a key); after that it only asks for the code. A verified code
 * raises the session to aal2 and rewrites the auth cookie, so the server's
 * next call carries it. The database decides what aal2 opens; this only
 * collects the code.
 */

export type TotpStep = "loading" | "enroll" | "verify";

/** Supabase Auth's MFA errors, in the words the person at the keyboard needs. */
export function plainMfaError(message: string | undefined, factorName = "MAYA God Mode"): string {
  const m = message ?? "";
  if (/invalid|incorrect|expired/i.test(m) && /code|totp|challenge/i.test(m)) {
    return "That code didn't work. Try the next one from your authenticator app.";
  }
  if (/mfa|factor/i.test(m) && /disabled|not enabled|unsupported|not allowed/i.test(m)) {
    return "Authenticator codes aren't switched on for this project yet. In Supabase, turn on Authentication, Multi-Factor Authentication, TOTP.";
  }
  if (/friendly name/i.test(m)) {
    return `An authenticator called ${factorName} already exists on this login. Remove it in Supabase and try again.`;
  }
  return m || "Something went wrong. Try again.";
}

export type TotpCode = {
  step: TotpStep;
  qr: string | null;
  secret: string | null;
  code: string;
  setCode: (code: string) => void;
  busy: boolean;
  error: string | null;
  /** Lists the login's authenticators and enrols one when there is none. */
  start: () => Promise<void>;
  /**
   * Checks the code, then runs `after` (still busy). `after` answers with a
   * refusal to show, or null when all went well.
   */
  submit: (after: () => Promise<string | null>) => Promise<void>;
};

/** `factorName` is the name the authenticator app shows for the code. */
export function useTotpCode(factorName: string): TotpCode {
  const [step, setStep] = useState<TotpStep>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStep("loading");
    setError(null);
    setCode("");
    setQr(null);
    setSecret(null);
    try {
      const supabase = createClient();
      const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) {
        setError(plainMfaError(listErr.message, factorName));
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
        friendlyName: factorName,
        issuer: "MAYA",
      });
      if (enrollErr || !enrolled) {
        setError(plainMfaError(enrollErr?.message, factorName));
        return;
      }
      setFactorId(enrolled.id);
      setQr(enrolled.totp.qr_code);
      setSecret(enrolled.totp.secret);
      setStep("enroll");
    } catch (e) {
      setError(plainMfaError(e instanceof Error ? e.message : undefined, factorName));
    }
  }

  async function submit(after: () => Promise<string | null>) {
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
        setError(plainMfaError(verifyErr.message, factorName));
        return;
      }
      const refusal = await after();
      if (refusal) setError(refusal);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return { step, qr, secret, code, setCode, busy, error, start, submit };
}

/** The QR code and key on first use, or the prompt; then the code field. Goes inside the caller's form. */
export function TotpCodeFields({ totp }: { totp: TotpCode }) {
  return (
    <>
      {totp.step === "enroll" ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            Scan this with your authenticator app, then enter the 6-digit code it shows.
          </p>
          {totp.qr ? (
            // A data: SVG straight from Supabase Auth: nothing for next/image to fetch or optimise.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={totp.qr} alt="QR code for your authenticator app" className="h-44 w-44 rounded bg-white p-2" />
          ) : null}
          {totp.secret ? (
            <p className="text-xs text-slate-400">
              Or type this key into the app: <code className="select-all break-all text-slate-200">{totp.secret}</code>
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
        value={totp.code}
        onChange={(e) => totp.setCode(e.target.value)}
        autoFocus
        className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-center text-lg tracking-[0.4em] text-slate-100"
      />
    </>
  );
}
