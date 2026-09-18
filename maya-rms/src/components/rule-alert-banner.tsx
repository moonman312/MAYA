"use client";

import { RoomCountHelp } from "@/components/room-type-settings";
import {
  alertChoiceHelp,
  alertLimitHelp,
  limitActionLabel,
  type RuleAlert,
  type RuleAlertChoice,
  type RuleAlertsView,
} from "@/lib/rule-alerts";
import { useCallback, useEffect, useState } from "react";

/** Nights named on the card before the rest go behind the disclosure. */
const PREVIEW_NIGHTS = 3;

/**
 * The one thing on the dashboard that asks the owner a question.
 *
 * A rule that has adjusted the same night three times or more keeps going,
 * and this is where MAYA says so: what it saw, where the price is heading,
 * and the two answers. It sits above the tabs, so it is there whether the
 * owner landed on the calendar or the rules. Someone below Revenue Manager
 * sees the same story with no buttons.
 *
 * A rule on a bad run can reach three fires on every night of the horizon, so
 * a card names the first few and keeps the rest behind a disclosure, and the
 * answers that cover the whole range come first. Without that the banner ran
 * to thousands of pixels and pushed the calendar, the rules and the change log
 * off the screen.
 */
export function RuleAlertBanner({
  activeHotelId,
  onAskForLimits,
}: {
  activeHotelId?: string | null;
  /** Takes the owner to where MAYA can suggest a floor or a ceiling. */
  onAskForLimits?: () => void;
}) {
  const [view, setView] = useState<RuleAlertsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rules/alerts");
      if (!res.ok) return;
      setView((await res.json()) as RuleAlertsView);
    } catch {
      // Demo or offline: nothing to ask about.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, activeHotelId]);

  async function answer(alert: RuleAlert, choice: RuleAlertChoice, stayDates: string[] | null) {
    setBusy(`${alert.id}|${stayDates?.join(",") ?? "all"}|${choice}`);
    setError(null);
    try {
      const res = await fetch(`/api/rules/alerts/${alert.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice, ...(stayDates ? { stay_dates: stayDates } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as (RuleAlertsView & { error?: string }) | null;
      if (!res.ok) {
        setError(body?.error ?? "That did not save. Try again in a moment.");
        return;
      }
      if (body) setView(body);
    } catch {
      setError("That did not save. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  }

  if (!view || view.alerts.length === 0) return null;

  return (
    <section
      aria-label="Rules that keep adjusting"
      className="mb-6 space-y-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-5"
    >
      {view.alerts.map((alert) => {
        const shown = alert.nights.slice(0, PREVIEW_NIGHTS);
        const more = alert.nights.length - shown.length;
        const nightCard = (night: RuleAlert["nights"][number]) => (
          <li key={`${alert.id}|${night.stay_date}`} className="rounded border border-amber-500/30 bg-slate-950/40 p-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium text-slate-100">{night.label}</span>
              <span className="text-xs text-slate-400">{night.fires_line}</span>
            </div>
            {night.why.map((line) => (
              <p key={line} className="mt-1 text-xs leading-snug text-slate-300">
                {line}
              </p>
            ))}
            {night.limit_line ? (
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs leading-snug text-slate-300">
                <span>{night.limit_line}</span>
                {night.limit_is_default ? (
                  <>
                    <RoomCountHelp {...alertLimitHelp(view.currency_symbol)} />
                    {onAskForLimits ? (
                      <button
                        type="button"
                        onClick={onAskForLimits}
                        className="cursor-pointer font-medium text-sky-300 underline hover:text-sky-200"
                      >
                        {limitActionLabel(alert.direction)}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </p>
            ) : null}
            {view.can_manage ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void answer(alert, "keep_adjusting", [night.stay_date])}
                  className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:cursor-default disabled:opacity-60"
                >
                  Keep adjusting
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void answer(alert, "stop", [night.stay_date])}
                  className="cursor-pointer rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-500 disabled:cursor-default disabled:opacity-60"
                >
                  Stop for this night
                </button>
              </div>
            ) : null}
          </li>
        );

        return (
          <div key={alert.id} className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-amber-100">{alert.headline}</h2>
              <p className="mt-0.5 text-xs text-amber-200/80">{alert.consequence}</p>
            </div>

            {view.can_manage ? (
              <div className="flex flex-wrap items-center gap-2">
                {alert.nights.length > 1 ? (
                  <>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void answer(alert, "keep_adjusting", null)}
                      className="cursor-pointer rounded border border-slate-600 px-3 py-1 text-xs font-medium text-slate-200 hover:border-slate-400 disabled:cursor-default disabled:opacity-60"
                    >
                      Keep adjusting on all {alert.nights.length} nights
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void answer(alert, "stop", null)}
                      className="cursor-pointer rounded border border-amber-500/60 px-3 py-1 text-xs font-medium text-amber-200 hover:border-amber-400 disabled:cursor-default disabled:opacity-60"
                    >
                      Stop on all {alert.nights.length} nights
                    </button>
                  </>
                ) : null}
                <RoomCountHelp {...alertChoiceHelp(alert.direction)} />
              </div>
            ) : (
              <p className="text-xs text-amber-200/80">Only a Revenue Manager or above can answer this.</p>
            )}

            {alert.nights.length === 1 ? (
              <ul className="space-y-3">{alert.nights.map(nightCard)}</ul>
            ) : (
              <details className="group">
                <summary className="cursor-pointer list-none text-xs text-amber-200/80 hover:text-amber-100">
                  {shown.map((n) => n.label).join(", ")}
                  {more > 0 ? ` and ${more} more night${more === 1 ? "" : "s"}` : ""}
                  <span className="ml-1.5 text-slate-400 group-open:hidden">Answer night by night</span>
                  <span className="ml-1.5 hidden text-slate-400 group-open:inline">Hide the nights</span>
                </summary>
                <ul className="mt-3 space-y-3">{alert.nights.map(nightCard)}</ul>
              </details>
            )}
          </div>
        );
      })}

      {error ? (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      ) : null}
    </section>
  );
}
