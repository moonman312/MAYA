"use client";

import { RoomCountHelp } from "@/components/room-type-settings";
import { currencySymbolFor } from "@/lib/changelog-route-helpers";
import { SUPPORT_EMAIL } from "@/lib/docs/home";

/**
 * The property's time zone and currency on the PMS tab, read-only, exactly as
 * saved on the hotel row.
 *
 * Nothing records whether they were read from the property's system: UTC and
 * US dollars are the column defaults, and what every connect path saves when
 * the read fails or comes back empty. So nothing here says they came from the
 * system. A UTC time zone is almost never a real property's, so it carries a
 * plain line saying what those values mean and how to get them corrected.
 *
 * On Cloudbeds both are read again once a day (property-changes.ts): a new
 * time zone is followed, and a new currency only while the property is in
 * simulation. The "?" says so on a Cloudbeds property.
 */

const HELP_LINES = [
  "These are saved for this property and can't be changed here. Send us a message to change either.",
  "Tonight means tonight in this time zone, for your rules and for the prices sent to your system.",
  "Amounts across MAYA are in this currency. Nothing is converted.",
];

/** The "?" line a Cloudbeds property adds: what the daily read does. */
export const CLOUDBEDS_DAILY_LINE =
  "MAYA checks both against Cloudbeds once a day and follows a new time zone. A new currency is followed only while you're in simulation.";

function help(pmsType: string | null | undefined) {
  return {
    label: "About the time zone and currency",
    title: "Time zone and currency",
    lines: pmsType === "cloudbeds" ? [...HELP_LINES, CLOUDBEDS_DAILY_LINE] : HELP_LINES,
  };
}

/** "EUR (€)", "USD ($)", or the code alone where it is its own symbol. Exported for tests. */
export function currencyLabel(code: string | null): string {
  if (!code) return "Not set";
  const symbol = currencySymbolFor(code).trim();
  return symbol === code ? code : `${code} (${symbol})`;
}

export function PropertyTimeAndCurrency({
  timezone,
  currency,
  pmsType = null,
}: {
  timezone: string | null;
  currency: string | null;
  /** The connected system; Cloudbeds' "?" says both are checked once a day. */
  pmsType?: string | null;
}) {
  const bothDefaults = timezone === "UTC" && currency === "USD";
  return (
    <div className="space-y-2 rounded border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        Time zone and currency
        <RoomCountHelp {...help(pmsType)} />
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-slate-500">Time zone</dt>
        <dd className="text-slate-200">{timezone ?? "Not set"}</dd>
        <dt className="text-slate-500">Currency</dt>
        <dd className="text-slate-200">{currencyLabel(currency)}</dd>
      </dl>
      {timezone === "UTC" ? (
        <p className="max-w-2xl text-xs text-amber-200/90">
          {bothDefaults
            ? "UTC and US dollars are what a property gets when its time zone and currency weren't read from its system. If either is wrong for your property, "
            : "UTC is what a property gets when its time zone wasn't read from its system. If yours is different, "}
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Time zone or currency")}`}
            className="underline underline-offset-2 hover:text-amber-100"
          >
            send us a message
          </a>{" "}
          and we&apos;ll correct it.
        </p>
      ) : null}
    </div>
  );
}
