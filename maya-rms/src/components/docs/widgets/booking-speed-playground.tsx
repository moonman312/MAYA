"use client";

import { useState } from "react";
import { engineFacts, readBookingSpeed, SPEED_LEVELS, type SpeedLevel } from "@/lib/docs/engine-facts";
import { cn } from "@/lib/utils";
import { Output, RangeField } from "./controls";

// The three notes "How did we know?" shows when a check held a reading back,
// quoted as the app writes them.
const GUARD_NOTES = {
  noise:
    "The raw numbers leaned away from Normal, but the gap was small enough to be ordinary noise at this volume, so we held the call at Normal.",
  extreme:
    "The raw numbers pointed at an even stronger call, but not by enough evidence to justify it, so we softened it one step.",
  few: "We found only a few genuinely comparable nights, so we kept the call within one step of Normal no matter how strong the numbers looked.",
};

function trimNumber(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}

/** The change log's opening words for a rule written for this level. */
export function changeLogSentence(level: SpeedLevel, recent: number, expected: number): string {
  const opening =
    level === "Stalled"
      ? "Bookings all but stopped this past week"
      : level === "Surging"
        ? "Bookings surged this past week"
        : level === "Normal"
          ? "Bookings came in at the normal pace this past week"
          : `Bookings came in ${level.toLowerCase()} this past week`;
  const count = recent === 0 ? "none" : String(recent);
  const usual =
    expected < 1
      ? "where a night like this usually has almost none by now"
      : `against the ${Math.round(expected)} a night like this usually has by now`;
  return `${opening}: ${count}, ${usual}.`;
}

export function BookingSpeedPlaygroundLive() {
  const [expected, setExpected] = useState(5);
  const [recent, setRecent] = useState(9);
  const [similar, setSimilar] = useState(5);
  const { bands, noiseGuard, extremeGuard, fewComparables, minExpected } = engineFacts.bookingSpeed;
  const r = readBookingSpeed(expected, recent, similar);
  const band = r.steps[0].level;
  const noise = noiseGuard(expected);
  const extreme = extremeGuard(expected);
  const divisor = Math.max(expected, minExpected);

  const lines: { title: string; body: string; note?: string; changed: boolean; skipped?: boolean }[] = [];
  lines.push({
    title: "Compare with what is usual",
    body: `${recent} is ${r.ratio.toFixed(2)} times the ${trimNumber(expected)} expected${expected < minExpected ? ` (counted as ${minExpected} for the division)` : ""}. On its own that reads ${band}.`,
    changed: false,
  });
  const noiseStep = r.steps[1];
  lines.push({
    title: "Is the gap big enough?",
    body: `The difference is ${trimNumber(Math.round(r.difference * 100) / 100)} booking${r.difference === 1 ? "" : "s"}. Leaving Normal needs at least ${trimNumber(Math.round(noise * 100) / 100)}.`,
    note: noiseStep.changed ? GUARD_NOTES.noise : undefined,
    changed: noiseStep.changed,
  });
  const extremeStep = r.steps[2];
  lines.push({
    title: "Big enough for the strongest level?",
    body: !extremeStep
      ? "Not needed: the reading is already Normal."
      : band === "Stalled" || band === "Surging"
        ? `Stalled and Surging need a difference of at least ${trimNumber(Math.round(extreme * 100) / 100)}.`
        : "Only Stalled and Surging need this check.",
    note: extremeStep?.changed ? GUARD_NOTES.extreme : undefined,
    changed: !!extremeStep?.changed,
    skipped: !extremeStep,
  });
  const fewStep = r.steps[3];
  lines.push({
    title: "Enough similar nights?",
    body: !fewStep
      ? "Not needed: the reading is already Normal."
      : similar < fewComparables
        ? `${similar} similar night${similar === 1 ? "" : "s"}, fewer than ${fewComparables}, so the reading stays within one step of Normal.`
        : `${similar} similar nights: the full range of levels is open.`,
    note: fewStep?.changed ? GUARD_NOTES.few : undefined,
    changed: !!fewStep?.changed,
    skipped: !fewStep,
  });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <RangeField label="Expected bookings" value={expected} min={0} max={30} step={0.5} onChange={setExpected} display={trimNumber(expected)} />
        <RangeField label="Bookings received" value={recent} min={0} max={60} onChange={setRecent} />
        <RangeField label="Similar nights found" value={similar} min={1} max={8} onChange={setSimilar} />
      </div>

      <Output changeKey={`${expected}-${recent}-${similar}`}>
        <div className="space-y-5">
        <ol className="space-y-3">
          {lines.map((line, i) => (
            <li key={line.title} className={cn("flex gap-3", line.skipped && "opacity-60")}>
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  line.changed ? "border-warning/60 bg-warning/15 text-warning" : "border-border text-muted-foreground"
                )}
              >
                {i + 1}
              </span>
              <div className="min-w-0 text-sm">
                <p className="font-medium text-foreground">{line.title}</p>
                <p className="text-muted-foreground">{line.body}</p>
                {line.note ? (
                  <p className="mt-1 border-l-2 border-warning/50 pl-2 text-foreground/80">&ldquo;{line.note}&rdquo;</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>

        <div>
          <p className="mb-2 text-sm font-medium text-foreground">
            The night reads <span className="text-primary">{r.level}</span>
          </p>
          <div className="grid grid-cols-7 gap-1" aria-hidden>
            {SPEED_LEVELS.map((level) => (
              <div key={level} className="space-y-1 text-center">
                <div
                  className={cn(
                    "h-2 rounded-full transition-colors",
                    level === r.level ? "bg-primary" : level === band && band !== r.level ? "bg-warning/50" : "bg-border"
                  )}
                />
                <p className={cn("text-[0.6rem] leading-tight sm:text-[0.7rem]", level === r.level ? "font-semibold text-foreground" : "text-muted-foreground")}>
                  {level.replace(" Than Normal", "")}
                </p>
              </div>
            ))}
          </div>
        </div>

        {r.level !== "Normal" ? (
          <p className="text-sm text-muted-foreground">
            A rule set to {r.level} writes in the change log, for Past week:{" "}
            <span className="text-foreground">&ldquo;{changeLogSentence(r.level, recent, expected)}&rdquo;</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">A Normal reading moves no Faster or Slower rule.</p>
        )}
        </div>
      </Output>
      <p className="text-xs text-muted-foreground">
        The lines between the levels: at least {bands.faster}, {bands.muchFaster} and {bands.surging} times what is usual on the fast side, and at most {trimNumber(1 / bands.faster)} times, half, and 1 in {bands.surging} on the slow side. Expected counts as at least {minExpected} for the division ({trimNumber(divisor)} here).
      </p>
    </div>
  );
}
