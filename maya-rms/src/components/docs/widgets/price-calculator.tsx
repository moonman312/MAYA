"use client";

import { useState } from "react";
import { money, priceFor } from "@/lib/docs/engine-facts";
import { NumberField, Output, RangeField, Segmented } from "./controls";

export function PriceCalculatorLive() {
  const [rooms, setRooms] = useState<number | "">(20);
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const n = rooms === "" ? 0 : Math.floor(rooms);
  const price = n >= 1 && n <= 500 ? priceFor(n, period) : null;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <RangeField label="Rooms" value={Math.min(Math.max(n, 1), 120)} min={1} max={120} onChange={setRooms} display={n || "none"} hint="Drag, or type any number up to 500 below." />
        <NumberField label="Or type your room count" value={rooms} min={1} max={500} onChange={setRooms} />
        <Segmented
          label="Billing"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "monthly", label: "Monthly" },
            { value: "yearly", label: "Yearly" },
          ]}
        />
      </div>
      <Output changeKey={`${n}-${period}`} className="self-start">
        {n > 500 ? (
          <p className="text-sm">Over 500 rooms is not sold self-serve. Email us.</p>
        ) : !price ? (
          <p className="text-sm">Type a whole number of rooms from 1 to 500.</p>
        ) : (
          <div className="space-y-2">
            <p>
              <span className="text-4xl font-bold tracking-tight tabular-nums text-foreground">{money(price.total)}</span>
              <span className="ml-2 text-sm text-muted-foreground">{period === "monthly" ? "a month" : "a year, paid once"}</span>
            </p>
            <p className="text-sm text-foreground">
              {n} room{n === 1 ? "" : "s"} is in the {price.bracket.min} to {price.bracket.max} room bracket: {money(price.bracket.perRoom, { cents: true })} per room, per month.
            </p>
            <p className="text-sm text-muted-foreground">
              {period === "yearly"
                ? price.bracket.yearlyOff
                  ? `That is 12 months of ${money(price.monthly)} with 10% off.`
                  : `From 1 to 20 rooms, yearly is 12 months at the monthly rate. The 10% saving starts at 21 rooms.`
                : price.bracket.yearlyOff
                  ? `Yearly: ${money(price.yearly)}, which saves 10%.`
                  : `Yearly: ${money(price.yearly)}, the same as 12 months. The 10% saving starts at 21 rooms.`}
            </p>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">US dollars, before any tax. The whole property bills at the bracket its room count falls in.</p>
      </Output>
    </div>
  );
}
