"use client";

import { useState } from "react";
import { money, stackPrice, type Adjustment } from "@/lib/docs/engine-facts";
import { NumberField, Output, Segmented } from "./controls";

function RuleControls({ n, rule, onChange }: { n: number; rule: Adjustment; onChange: (r: Adjustment) => void }) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-border p-3">
      <legend className="px-1 text-sm font-semibold text-foreground">Rule {n}</legend>
      <Segmented
        label="Direction"
        value={rule.direction}
        onChange={(direction) => onChange({ ...rule, direction })}
        options={[
          { value: "up", label: "Increase" },
          { value: "down", label: "Decrease" },
        ]}
      />
      <div className="grid grid-cols-2 gap-3">
        <Segmented
          label="By"
          value={rule.kind}
          onChange={(kind) => onChange({ ...rule, kind })}
          options={[
            { value: "percent", label: "%" },
            { value: "amount", label: "$" },
          ]}
        />
        <NumberField
          label="Amount"
          value={rule.value}
          min={0}
          step={rule.kind === "percent" ? 1 : 5}
          suffix={rule.kind === "percent" ? "%" : undefined}
          prefix={rule.kind === "amount" ? "$" : undefined}
          onChange={(v) => onChange({ ...rule, value: v === "" ? 0 : Math.max(0, v) })}
        />
      </div>
    </fieldset>
  );
}

function describe(rule: Adjustment) {
  const verb = rule.direction === "up" ? "raises" : "cuts";
  return rule.kind === "percent" ? `${verb} ${rule.value}%` : `${verb} ${money(rule.value)}`;
}

export function StackingCalculatorLive() {
  const [base, setBase] = useState<number | "">(200);
  const [rule1, setRule1] = useState<Adjustment>({ kind: "percent", direction: "up", value: 10 });
  const [rule2, setRule2] = useState<Adjustment>({ kind: "percent", direction: "up", value: 25 });
  const [floor, setFloor] = useState<number | "">(110);
  const [ceiling, setCeiling] = useState<number | "">(300);

  const b = base === "" ? 0 : base;
  const f = floor === "" ? 0 : floor;
  const c = ceiling === "" ? 99999.99 : ceiling;
  const result = stackPrice(b, [rule1, rule2], f, Math.max(c, f));
  const key = JSON.stringify([base, rule1, rule2, floor, ceiling]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <NumberField label="Starting price" value={base} min={0} step={5} prefix="$" onChange={setBase} />
        <RuleControls n={1} rule={rule1} onChange={setRule1} />
        <RuleControls n={2} rule={rule2} onChange={setRule2} />
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Floor" value={floor} min={0} step={5} prefix="$" onChange={setFloor} />
          <NumberField label="Ceiling" value={ceiling} min={0} step={5} prefix="$" onChange={setCeiling} />
        </div>
      </div>
      <Output changeKey={key} className="self-start">
        <ol className="space-y-2 font-mono text-sm tabular-nums">
          <li className="flex justify-between gap-4">
            <span className="font-sans text-muted-foreground">Start</span>
            <span>{money(b, { cents: true })}</span>
          </li>
          <li className="flex justify-between gap-4">
            <span className="font-sans text-muted-foreground">Rule 1 {describe(rule1)}</span>
            <span>{money(result.steps[0], { cents: true })}</span>
          </li>
          <li className="flex justify-between gap-4">
            <span className="font-sans text-muted-foreground">Rule 2 {describe(rule2)}</span>
            <span>{money(result.steps[1], { cents: true })}</span>
          </li>
          <li className="flex justify-between gap-4 border-t border-border pt-2 text-base font-semibold text-foreground">
            <span className="font-sans">Published</span>
            <span>{money(result.published, { cents: true })}</span>
          </li>
        </ol>
        <p className="mt-3 text-sm text-muted-foreground">
          {result.clampedBy === "ceiling"
            ? `That would have gone past your ${money(c, { cents: true })} ceiling, so it stopped there.`
            : result.clampedBy === "floor"
              ? `That would have gone below your ${money(f, { cents: true })} floor, so it stopped there.`
              : `Inside your ${money(f)} floor and ${money(c)} ceiling, so ${money(result.published, { cents: true })} is published.`}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Percents multiply, amounts add, and the result is rounded to the cent.
        </p>
      </Output>
    </div>
  );
}
