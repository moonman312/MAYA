"use client";

import { GOD_MODE_CHANGED_EVENT } from "@/components/admin/god-mode-banner";
import { TotpCodeFields, useTotpCode } from "@/components/admin/totp-code";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export { plainMfaError } from "@/components/admin/totp-code";

/** The name the authenticator shows for the code. */
const FACTOR_NAME = "MAYA God Mode";

/**
 * The big red button. Pressing it asks for a code from the admin's
 * authenticator app (enrolling one first, with a QR code, when the login has
 * none), which raises the session to aal2, then asks the server to open a
 * God Mode window. The database checks both; this only collects the code.
 * Only ever rendered for platform admins: a developer or sales login is
 * refused God Mode by the database whatever it sends.
 */
export function GodModeButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const totp = useTotpCode(FACTOR_NAME);

  function begin() {
    setOpen(true);
    void totp.start();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    await totp.submit(async () => {
      // The session is aal2 now and the auth cookie has been rewritten, so the
      // server's call carries it.
      const res = await fetch("/api/admin/god-mode", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return body.error ?? "Could not turn on God Mode. Try again.";
      }
      setOpen(false);
      window.dispatchEvent(new Event(GOD_MODE_CHANGED_EVENT));
      router.refresh();
      return null;
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={begin}
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

            {totp.step === "loading" && !totp.error ? (
              <p className="mt-4 text-sm text-slate-400">Checking your authenticator...</p>
            ) : null}

            {totp.step !== "loading" ? (
              <form className="mt-4 space-y-4" onSubmit={submit}>
                <TotpCodeFields totp={totp} />
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
                    disabled={totp.busy}
                    className="cursor-pointer rounded bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {totp.busy ? "Checking..." : "Turn on God Mode"}
                  </button>
                </div>
              </form>
            ) : null}

            {totp.error ? <p className="mt-3 text-sm text-rose-300">{totp.error}</p> : null}
            {totp.step === "loading" && totp.error ? (
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
