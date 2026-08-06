"use client";

import type { PmsRegistryStatus } from "@/lib/pms/registry";

/**
 * PMS picker, straight after payment. Options come from the registry — a PMS
 * shows as connectable only when it has an onboarding adapter AND its env
 * is configured; everything else renders as "coming soon".
 *
 * There is no way back from here on purpose: the payment is done, and the only
 * thing left before MAYA can do anything is knowing where the bookings live.
 */
export function ConnectPms({ pmsOptions }: { pmsOptions: PmsRegistryStatus[] }) {
  const available = pmsOptions.filter((p) => p.onboardingSupported && p.configured);
  const comingSoon = pmsOptions.filter((p) => !p.onboardingSupported || !p.configured);

  return (
    <div className="flex flex-col items-center pt-10">
      <h1 className="text-2xl font-semibold text-slate-100">
        Connect your property system
      </h1>
      <p className="mt-3 max-w-lg text-center text-sm leading-relaxed text-slate-400">
        Last thing. Pick your property management system, sign in on their
        site, and you&apos;ll be brought right back — no keys to copy, nothing
        to configure on their end.
      </p>

      {/* What happens when you connect */}
      <div className="mt-8 w-full max-w-lg rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
        <div className="text-sm font-semibold text-amber-200">
          What happens when you connect
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-amber-100/80">
          We&apos;ll pull your reservation history and analyze it to suggest
          the best yield automation strategy for your property. This runs in
          the background — you can keep going while it works. We never store
          guest personal data, and we won&apos;t change any of your prices
          without your say-so.
        </p>
      </div>

      <div className="mt-6 grid w-full max-w-lg gap-3">
        {available.map((pms) => (
          <a
            key={pms.type}
            href={`/api/pms/${pms.type}/connect?intent=onboarding`}
            className="group flex cursor-pointer items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-5 py-4 transition-colors hover:border-sky-500/60"
          >
            <div>
              <div className="text-sm font-semibold text-slate-100">
                {pms.displayName}
              </div>
              <div className="text-[11px] text-slate-400">
                Sign in with your {pms.displayName} account
              </div>
            </div>
            <span className="text-sm font-medium text-sky-400 group-hover:text-sky-300">
              Connect →
            </span>
          </a>
        ))}

        {available.length === 0 ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-4 text-sm text-slate-400">
            No property systems are available on this deployment yet. Contact
            support and we&apos;ll get you set up.
          </div>
        ) : null}

        {comingSoon.length > 0 ? (
          <div className="mt-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-600">
              Coming soon
            </div>
            <div className="mt-2 grid gap-2">
              {comingSoon.map((pms) => (
                <div
                  key={pms.type}
                  className="flex items-center justify-between rounded-lg border border-slate-800/60 bg-slate-900/50 px-5 py-3 opacity-60"
                >
                  <span className="text-sm text-slate-400">{pms.displayName}</span>
                  <span className="text-[11px] text-slate-600">Not yet available</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
