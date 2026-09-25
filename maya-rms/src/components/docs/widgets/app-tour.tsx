"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

// A drawing of the MAYA dashboard, not a screenshot: made-up property, no
// real data. Each numbered spot explains one part.
export const TOUR_PARTS = [
  { id: "logo", label: "The header", note: "The MAYA logo, top left. Help, Billing, Team and Sign Out sit top right." },
  { id: "buttons", label: "Help, Billing, Team, Sign Out", note: "Help opens the docs page about the screen you are on. Billing and Team are for a General Manager or Hotel Admin. Sign Out ends your session." },
  { id: "banners", label: "Banners", note: "They appear only when something needs you: billing, a lost connection, the review, or rules that keep adjusting." },
  { id: "tabs", label: "The five tabs", note: "Calendar, Rules, Rate Simulator, Change Log and PMS. Calendar opens first; the tab you are on stays in the address." },
  { id: "property", label: "The Property dropdown", note: "Every property you belong to, in alphabetical order. Your choice is kept." },
  { id: "day", label: "A day card", note: "The night's sellable occupancy, rooms booked out of rooms you can sell, the revenue on the books and a thin colour bar. Click it to open the day." },
] as const;

type PartId = (typeof TOUR_PARTS)[number]["id"];

function Spot({ n, id, active, onShow }: { n: number; id: PartId; active: PartId | null; onShow: (id: PartId | null) => void }) {
  const part = TOUR_PARTS.find((p) => p.id === id)!;
  return (
    <button
      type="button"
      aria-label={`${n}. ${part.label}`}
      aria-pressed={active === id}
      onMouseEnter={() => onShow(id)}
      onFocus={() => onShow(id)}
      onClick={() => onShow(active === id ? null : id)}
      className={cn(
        "relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold ring-2 ring-background transition-transform focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/60",
        active === id ? "scale-110 bg-primary text-primary-foreground" : "bg-foreground text-background hover:scale-110"
      )}
    >
      {n}
    </button>
  );
}

export function AppTourLive() {
  const [active, setActive] = useState<PartId | null>("tabs");
  const current = TOUR_PARTS.find((p) => p.id === active);
  const at = (id: PartId) => TOUR_PARTS.findIndex((p) => p.id === id) + 1;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <div className="relative min-w-[30rem] rounded-xl border border-border bg-background p-3 text-[0.7rem] select-none">
          {/* header */}
          <div className="flex items-center justify-between border-b border-border pb-2">
            <div className="flex items-center gap-2">
              <div>
                <p className="text-sm font-bold tracking-wide">MAYA</p>
                <span className="mt-1 block h-1 w-20 rounded-full bg-muted-foreground/25" />
                <span className="mt-0.5 block h-1 w-14 rounded-full bg-muted-foreground/20" />
              </div>
              <Spot n={at("logo")} id="logo" active={active} onShow={setActive} />
            </div>
            <div className="flex items-center gap-1.5">
              <Spot n={at("buttons")} id="buttons" active={active} onShow={setActive} />
              {["Help", "Billing", "Team", "Sign Out"].map((b) => (
                <span key={b} className="rounded-md border border-border px-2 py-0.5 text-muted-foreground">
                  {b}
                </span>
              ))}
            </div>
          </div>
          {/* tabs */}
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {["Calendar", "Rules", "Rate Simulator", "Change Log", "PMS"].map((t, i) => (
                <span key={t} className={cn("rounded-md px-2 py-1", i === 0 ? "bg-primary/15 font-semibold text-foreground" : "text-muted-foreground")}>
                  {t}
                </span>
              ))}
              <Spot n={at("tabs")} id="tabs" active={active} onShow={setActive} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">Property ▾</span>
              <Spot n={at("property")} id="property" active={active} onShow={setActive} />
            </div>
          </div>
          {/* banner */}
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-foreground">
            <span>A banner shows here only when something needs you.</span>
            <Spot n={at("banners")} id="banners" active={active} onShow={setActive} />
          </div>
          {/* calendar grid */}
          <div className="mt-2 grid grid-cols-7 gap-1">
            {Array.from({ length: 14 }, (_, i) => {
              const pct = [62, 70, 45, 38, 81, 95, 90, 55, 60, 41, 35, 77, 92, 88][i];
              return (
                <div key={i} className={cn("relative rounded-md border border-border p-1", i === 5 && "border-primary/60 bg-primary/5")}>
                  <p className="font-semibold">{i + 1}</p>
                  <p className="text-muted-foreground">{pct}%</p>
                  <div className={cn("mt-1 h-1 rounded-full", pct >= 80 ? "bg-primary" : pct >= 50 ? "bg-primary/50" : "bg-muted-foreground/30")} />
                  {i === 5 ? (
                    <span className="absolute top-1 right-1">
                      <Spot n={at("day")} id="day" active={active} onShow={setActive} />
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div aria-live="polite" className="min-h-14 rounded-xl bg-muted/50 p-4 text-sm">
        {current ? (
          <p>
            <span className="font-semibold text-foreground">{current.label}.</span> <span className="text-muted-foreground">{current.note}</span>
          </p>
        ) : (
          <p className="text-muted-foreground">Point at a number, or tab to it, to see what that part does.</p>
        )}
      </div>
      <ol className="sr-only">
        {TOUR_PARTS.map((p) => (
          <li key={p.id}>
            {p.label}: {p.note}
          </li>
        ))}
      </ol>
    </div>
  );
}
