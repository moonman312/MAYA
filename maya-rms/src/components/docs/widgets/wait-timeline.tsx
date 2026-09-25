"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Output, SelectField } from "./controls";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WAITS = [
  { value: "1", label: "1 day" },
  { value: "2", label: "2 days" },
  { value: "3", label: "3 days" },
  { value: "7", label: "1 week" },
  { value: "14", label: "2 weeks" },
];
const WINDOWS = [
  { value: "1", label: "Past day" },
  { value: "7", label: "Past week" },
  { value: "30", label: "Past month" },
];

function listDays(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * After a booking speed rule raises a night it waits (in 24-hour periods),
 * then reads the night again counting only what came in since the raise,
 * starting with the rest of the raise's own day, and never more days than
 * its Measured over window.
 */
export function WaitTimelineLive() {
  const [wait, setWait] = useState("2");
  const [fireDay, setFireDay] = useState("0");
  const [windowDays, setWindowDays] = useState("7");
  const w = Number(wait);
  const start = Number(fireDay);
  const win = Number(windowDays);
  const endIndex = w; // the day the wait ends, counted from the raise's day
  const counted = Math.min(win, endIndex + 1);
  const firstCounted = endIndex + 1 - counted; // index of the first day counted
  const includesRaiseDay = firstCounted === 0;
  const strip = Array.from({ length: 15 }, (_, i) => ({ i, name: DAYS[(start + i) % 7] }));
  const nameAt = (i: number) => (i === 0 ? `${DAYS[start]} afternoon` : i <= 7 ? DAYS[(start + i) % 7] : `the ${DAYS[(start + i) % 7]} after`);

  const countedNames = strip
    .filter((d) => d.i >= firstCounted && d.i <= endIndex)
    .map((d) => (d.i === 0 ? `${d.name} after the raise` : d.name));

  let sentence: string;
  if (w >= 7) {
    sentence = `After a ${WAITS.find((x) => x.value === wait)!.label} wait from a raise on ${DAYS[start]} afternoon, the rule reads the night again on ${nameAt(endIndex)} afternoon. It counts the last ${counted} day${counted === 1 ? "" : "s"}${includesRaiseDay ? ", starting with the rest of the raise's day" : ", all after the raise"}, against the same ${counted} day${counted === 1 ? "" : "s"} of similar nights.`;
  } else {
    sentence = `After a ${WAITS.find((x) => x.value === wait)!.label} wait from a raise on ${DAYS[start]} afternoon, the rule reads the night again on ${DAYS[(start + endIndex) % 7]} afternoon and counts only the bookings made since the raise: ${listDays(countedNames)}. That is ${counted} day${counted === 1 ? "" : "s"}, compared with the same ${counted} day${counted === 1 ? "" : "s"} of similar nights.`;
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField label="Raised on" value={fireDay} onChange={setFireDay} options={DAYS.map((d, i) => ({ value: String(i), label: `${d} afternoon` }))} />
        <SelectField label="Then waits" value={wait} onChange={setWait} options={WAITS} />
        <SelectField label="Measured over" value={windowDays} onChange={setWindowDays} options={WINDOWS} />
      </div>
      <div className="overflow-x-auto pb-1">
        <ol className="grid min-w-[36rem] grid-cols-15 gap-1" aria-label="Fifteen days from the raise">
          {strip.map((d) => {
            const waiting = d.i < endIndex;
            const isEnd = d.i === endIndex;
            const isCounted = d.i >= firstCounted && d.i <= endIndex;
            return (
              <li key={d.i} className="space-y-1 text-center">
                <div
                  className={cn(
                    "relative flex h-12 flex-col items-center justify-center rounded-lg border text-[0.7rem] font-medium",
                    d.i > endIndex && "border-border text-muted-foreground/60",
                    waiting && "border-warning/40 bg-warning/10 text-foreground",
                    isEnd && "border-primary bg-primary/15 text-foreground"
                  )}
                >
                  <span>{d.name.slice(0, 3)}</span>
                  {d.i === 0 ? <span className="text-[0.6rem] text-warning">raised</span> : null}
                  {isEnd ? <span className="text-[0.6rem] text-primary">reads</span> : null}
                </div>
                <div className={cn("h-1.5 rounded-full", isCounted ? (d.i === 0 ? "bg-primary/50" : "bg-primary") : "bg-transparent")} />
              </li>
            );
          })}
        </ol>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] border border-warning/40 bg-warning/10" /> waiting
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] border border-primary bg-primary/15" /> reads the night again
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-4 rounded-full bg-primary" /> days counted
        </span>
      </p>
      <Output changeKey={`${wait}-${fireDay}-${windowDays}`}>
        <p className="text-sm text-foreground">{sentence}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          If the bookings since the raise read the rule&apos;s level or beyond, it raises again and the wait starts over. If not, the price holds at one raise.
        </p>
      </Output>
    </div>
  );
}
