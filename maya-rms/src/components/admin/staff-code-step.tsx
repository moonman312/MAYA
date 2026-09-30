"use client";

import { TotpCodeFields, useTotpCode } from "@/components/admin/totp-code";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef } from "react";

/** The name the authenticator app shows for this code. */
const FACTOR_NAME = "MAYA Command Center";

/**
 * The code step for a developer or sales login (/admin-code): the God Mode
 * button's enrolment and code, on a page of its own. The first visit sets up
 * an authenticator app (QR code and key); after that each sign-in asks for a
 * code. A verified code makes the session aal2, and the Command Center lets
 * them in.
 */
export function StaffCodeStep() {
  const router = useRouter();
  const totp = useTotpCode(FACTOR_NAME);
  const started = useRef(false);
  const { start } = totp;

  useEffect(() => {
    // Once per visit, even when React runs effects twice in development: a
    // second enrolment under the same name would be refused.
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await totp.submit(async () => {
      router.replace("/admin");
      router.refresh();
      return null;
    });
  }

  return (
    <div className="space-y-4">
      {totp.step === "enroll" ? (
        <p className="text-sm text-slate-400">
          The Command Center needs a code from an authenticator app. Set it up once, then enter a code each time you
          sign in.
        </p>
      ) : null}
      {totp.step === "loading" && !totp.error ? (
        <p className="text-sm text-slate-400">Checking your authenticator...</p>
      ) : null}
      {totp.step !== "loading" ? (
        <form className="space-y-4" onSubmit={submit}>
          <TotpCodeFields totp={totp} />
          <button
            type="submit"
            disabled={totp.busy}
            className="w-full cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {totp.busy ? "Checking..." : "Open the Command Center"}
          </button>
        </form>
      ) : null}
      {totp.error ? <p className="text-sm text-rose-300">{totp.error}</p> : null}
    </div>
  );
}
