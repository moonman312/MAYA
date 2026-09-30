"use client";

import { RoomCountHelp } from "@/components/room-type-settings";
import { NIGHT_COLOR_CLASS, colorKey, colorKeyHelp, type CalendarColors } from "@/lib/calendar-display";

const COLOR_NAME = { green: "Green", orange: "Amber", red: "Red" } as const;

/**
 * The small key on the left of the calendar: what each colour means in this
 * property's colours. A narrow column beside the grid on a wide screen, one
 * short line above it on a phone, where the reversed colours' cues are left
 * off to fit. How a night gets its colour sits behind the "?".
 *
 * `mode` null: the month has not loaded yet, so the key holds its place
 * without saying anything it might have to take back.
 */
export function CalendarColorKey({ mode }: { mode: CalendarColors | null }) {
  return (
    <div
      data-testid="calendar-color-key"
      data-mode={mode ?? undefined}
      className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] leading-snug text-slate-400 lg:w-24 lg:shrink-0 lg:flex-col lg:items-start lg:gap-y-2 lg:pt-1"
    >
      {mode
        ? colorKey(mode).map((entry) => (
            <span key={entry.color} className="flex items-center gap-1.5 lg:items-start" data-color={entry.color}>
              <span aria-hidden className={`inline-block h-1 w-4 shrink-0 rounded lg:mt-[0.4rem] ${NIGHT_COLOR_CLASS[entry.color]}`} />
              <span>
                <span className="sr-only">{COLOR_NAME[entry.color]}: </span>
                {entry.words}
                {entry.cue ? <span className="hidden lg:inline">, {entry.cue}</span> : null}
              </span>
            </span>
          ))
        : null}
      {mode ? (
        <RoomCountHelp label="What the colours mean" title="What the colours mean" lines={colorKeyHelp(mode)} docs="calendar-colors" />
      ) : null}
    </div>
  );
}
