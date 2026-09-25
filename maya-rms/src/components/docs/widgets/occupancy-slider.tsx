"use client";

import { useState } from "react";
import { occupancyFires, sellableOccupancy } from "@/lib/docs/engine-facts";
import { OCCUPANCY_DEFAULTS } from "@/lib/docs/widget-fallbacks.mjs";
import { cn } from "@/lib/utils";
import { Output, RangeField, Segmented, Verdict } from "./controls";

type Compare = "greater" | "less";

export interface OccupancySliderProps {
  rooms?: number;
  outOfService?: number;
  booked?: number;
  threshold?: number;
  compare?: Compare;
}

export function OccupancySliderLive(props: OccupancySliderProps) {
  const start = { ...OCCUPANCY_DEFAULTS, ...props };
  const [rooms, setRooms] = useState(start.rooms);
  const [oos, setOos] = useState(Math.min(start.outOfService, start.rooms));
  const [booked, setBooked] = useState(Math.min(start.booked, start.rooms));
  const [threshold, setThreshold] = useState(start.threshold);
  const [compare, setCompare] = useState<Compare>(start.compare as Compare);

  const changeRooms = (n: number) => {
    setRooms(n);
    setOos((v) => Math.min(v, n));
    setBooked((v) => Math.min(v, n));
  };

  const sellable = rooms - oos;
  const pct = sellableOccupancy(rooms, oos, booked);
  const fires = occupancyFires(pct, compare, threshold);
  const shown = pct === null ? null : Math.round(pct);
  const exactlyOnLine = pct !== null && Math.abs(pct - threshold) < 1e-9;
  const label = compare === "greater" ? "Greater than" : "Less than";

  // One square per room: booked, free to sell, or out of service.
  const squares = Array.from({ length: rooms }, (_, i) => {
    if (i >= rooms - oos) return "oos";
    return i < booked ? "booked" : "free";
  });
  const overbooked = Math.max(0, booked - sellable);

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <RangeField label="Rooms of this type" value={rooms} min={1} max={40} onChange={changeRooms} />
        <RangeField label="Out of service" value={oos} min={0} max={rooms} onChange={setOos} />
        <RangeField label="Booked" value={booked} min={0} max={rooms} onChange={setBooked} />
        <Segmented
          label="Compare"
          value={compare}
          onChange={setCompare}
          options={[
            { value: "greater", label: "Greater than" },
            { value: "less", label: "Less than" },
          ]}
        />
        <RangeField label="Threshold" value={threshold} min={0} max={100} onChange={setThreshold} display={`${threshold}%`} />
      </div>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5" aria-hidden>
          {squares.map((kind, i) => (
            <span
              key={i}
              className={cn(
                "size-5 rounded-[5px] border transition-colors",
                kind === "booked" && "border-primary bg-primary",
                kind === "free" && "border-border bg-background",
                kind === "oos" && "border-dashed border-muted-foreground/40 bg-[repeating-linear-gradient(135deg,transparent,transparent_3px,var(--border)_3px,var(--border)_5px)]"
              )}
            />
          ))}
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded-[3px] bg-primary" /> booked
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded-[3px] border border-border bg-background" /> free to sell
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded-[3px] border border-dashed border-muted-foreground/40" /> out of service
          </span>
        </p>
        <Output changeKey={`${rooms}-${oos}-${booked}-${threshold}-${compare}`}>
          {pct === null ? (
            <p className="text-sm">No rooms to sell that night, so there is no occupancy to compare and the rule does not fire.</p>
          ) : (
            <div className="space-y-3">
              <p>
                <span className="text-4xl font-bold tracking-tight tabular-nums text-foreground">{shown}%</span>
                <span className="ml-2 text-sm text-muted-foreground">sellable occupancy</span>
              </p>
              <p className="text-sm text-foreground">
                {booked} of {sellable} sellable room{sellable === 1 ? "" : "s"}
                {oos > 0 ? ` (${rooms} rooms, minus ${oos} out of service)` : ""}.
                {overbooked > 0 ? " More rooms are booked than can be sold, so it reads over 100%." : ""}
              </p>
              <Verdict yes={fires}>{fires ? "Your rule fires" : "Your rule does not fire"}</Verdict>
              <p className="text-sm text-muted-foreground">
                {label} {threshold}
                {exactlyOnLine
                  ? ` means ${compare === "greater" ? "more" : "less"} than ${threshold}, so exactly ${threshold}% does not fire.`
                  : fires
                    ? ` holds: ${shown === threshold ? `${pct!.toFixed(1)}%` : `${shown}%`} is ${compare === "greater" ? "more" : "less"} than ${threshold}.`
                    : ` does not hold: ${shown === threshold ? `${pct!.toFixed(1)}%` : `${shown}%`} is not ${compare === "greater" ? "more" : "less"} than ${threshold}.`}
              </p>
            </div>
          )}
        </Output>
      </div>
    </div>
  );
}
