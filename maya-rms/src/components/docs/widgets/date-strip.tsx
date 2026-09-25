"use client";

import { useState } from "react";
import { engineFacts } from "@/lib/docs/engine-facts";
import { cn } from "@/lib/utils";
import { Output, RangeField, Segmented } from "./controls";

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"];

function covers(compare: "less" | "greater", threshold: number): string {
  const last = engineFacts.windowNights - 1;
  if (compare === "less") {
    if (threshold <= 0) return `Less than ${threshold} covers no night at all.`;
    if (threshold === 1) return "Less than 1 covers tonight only.";
    const rest = threshold - 1;
    const restWords = rest < WORDS.length ? WORDS[rest] : String(rest);
    return `Less than ${threshold} covers tonight and the next ${restWords} night${rest === 1 ? "" : "s"} (0 to ${Math.min(rest, last)}).`;
  }
  if (threshold >= last) return `Greater than ${threshold} covers no night in the ${engineFacts.windowNights}-night window.`;
  if (threshold === 0) return "Greater than 0 covers every night except tonight.";
  return `Greater than ${threshold} covers nights ${threshold + 1} days away and further, up to the edge of the ${engineFacts.windowNights}-night window.`;
}

/** Which nights a booking window condition covers, counted from tonight (0). */
export function DateStripLive() {
  const [compare, setCompare] = useState<"less" | "greater">("less");
  const [threshold, setThreshold] = useState(7);
  const nights = Array.from({ length: 15 }, (_, i) => i);
  const on = (n: number) => (compare === "less" ? n < threshold : n > threshold);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Segmented
          label="Compare"
          value={compare}
          onChange={setCompare}
          options={[
            { value: "less", label: "Less than" },
            { value: "greater", label: "Greater than" },
          ]}
        />
        <RangeField label="Threshold (days)" value={threshold} min={0} max={30} onChange={setThreshold} />
      </div>
      <div className="overflow-x-auto pb-1">
        <ol className="grid min-w-[34rem] grid-cols-15 gap-1" aria-label="Tonight and the next 14 nights">
          {nights.map((n) => (
            <li
              key={n}
              className={cn(
                "flex h-14 flex-col items-center justify-center rounded-lg border text-center text-[0.7rem] leading-tight transition-colors",
                on(n) ? "border-primary bg-primary/15 font-semibold text-foreground" : "border-border text-muted-foreground"
              )}
            >
              <span>{n === 0 ? "Tonight" : n === 1 ? "Tmrw" : `+${n}`}</span>
              <span className="font-mono text-[0.65rem] opacity-70">{n}</span>
            </li>
          ))}
        </ol>
      </div>
      <Output changeKey={`${compare}-${threshold}`}>
        <p className="text-sm text-foreground">{covers(compare, threshold)}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Comparisons are strict, so the threshold night itself is never covered. Each number is days from tonight, on your property&apos;s own calendar.
        </p>
      </Output>
    </div>
  );
}
