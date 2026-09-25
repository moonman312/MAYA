"use client";

import { useState } from "react";
import { floorOffers, money } from "@/lib/docs/engine-facts";
import { cn } from "@/lib/utils";
import { NumberField, Output } from "./controls";

export function FloorLadderLive() {
  const [cost, setCost] = useState<number | "">(35);
  const [step, setStep] = useState(0);
  const [taken, setTaken] = useState<number | null>(null);
  const offers = floorOffers(cost === "" ? null : cost, 8);
  const offer = offers[Math.min(step, offers.length - 1)];

  function changeCost(v: number | "") {
    setCost(v);
    setStep(0);
    setTaken(null);
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div className="space-y-2">
        <NumberField label="Turnover cost" value={cost} min={0} prefix="$" placeholder="skipped" onChange={changeCost} />
        <p className="text-xs text-muted-foreground">Leave it empty to see what happens when the question is skipped.</p>
      </div>
      <Output changeKey={`${cost}-${step}-${taken}`}>
        <p className="text-sm text-muted-foreground">Picture a Tuesday in your slowest month. You&apos;re at 10% occupancy.</p>
        {taken === null ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setTaken(offer)}
              className="rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              I&apos;d take {money(offer)}
            </button>
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              disabled={step >= offers.length - 1}
              className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              Too low
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-foreground">
              Your floor would be <span className="font-semibold">{money(taken)}</span> on every room type, straight away.
            </p>
            <button
              type="button"
              onClick={() => {
                setTaken(null);
                setStep(0);
              }}
              className="text-sm font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"
            >
              Start again
            </button>
          </div>
        )}
        {step >= 2 && taken === null ? (
          <p className="mt-3 text-sm text-muted-foreground">
            A reminder appears here: a night like this would otherwise earn nothing, so anything above your turnover cost is profit.
          </p>
        ) : null}
        <p className="mt-4 text-xs text-muted-foreground">Offers in order:</p>
        <ol className="mt-1 flex flex-wrap gap-1.5">
          {offers.slice(0, 6).map((o, i) => (
            <li
              key={i}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-xs tabular-nums",
                i === step && taken === null ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
              )}
            >
              {money(o)}
            </li>
          ))}
        </ol>
      </Output>
    </div>
  );
}
