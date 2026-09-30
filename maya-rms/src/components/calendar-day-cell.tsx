"use client";

import {
  NIGHT_COLOR_CLASS,
  metricLine,
  nightColor,
  type CalendarDisplay,
} from "@/lib/calendar-display";
import type { CalendarDay } from "@/types/domain";

/**
 * The big number's usual size (1.125rem), smaller only when the day is too
 * narrow to hold it. On a phone the seven days share the screen's width, so
 * the room around them (the page's, the calendar's and each day's side
 * padding, the gaps between days) is in px there: a larger text size never
 * takes width away from the days, so their numbers are never smaller than
 * at the standard size.
 */
function fitted(text: string): string {
  return `min(1.125rem, calc(150cqi / ${Math.max(3, text.length)}))`;
}

/**
 * One day on the calendar: the day number, the big number and the small
 * lines the property chose in Settings, then the colour bar in the
 * property's colours. With the default choices it is the day as it always
 * was: occupancy, "12/20 rooms", the room revenue.
 */
export function CalendarDayCell({
  day,
  data,
  display,
  symbol,
  priceRoomTypeName,
  selected,
  onSelect,
}: {
  day: number;
  data: CalendarDay;
  display: CalendarDisplay;
  symbol: string;
  priceRoomTypeName: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const opts = { symbol, priceRoomTypeId: display.price_room_type_id, priceRoomTypeName };
  const big = metricLine(display.big, data, opts);
  const shown = nightColor(data.color, display.colors);
  return (
    <button
      type="button"
      className={`@container min-w-0 cursor-pointer overflow-hidden rounded border border-slate-700 px-[2px] py-1.5 text-left hover:border-sky-400 sm:p-2 ${
        selected ? "ring-2 ring-sky-400" : ""
      }`}
      onClick={onSelect}
    >
      <div className="text-xs text-slate-400">{day}</div>
      <div className="leading-7 font-semibold whitespace-nowrap" title={big.title} data-metric={display.big}>
        {/* A day narrower than 5rem (a phone) shows the short form, and both
            forms keep the usual size unless the day is too narrow to hold them. */}
        <span className="@min-[5rem]:hidden" style={{ fontSize: fitted(big.short) }}>
          {big.short}
        </span>
        <span className="hidden @min-[5rem]:inline" style={{ fontSize: fitted(big.value) }}>
          {big.value}
        </span>
      </div>
      {display.small.map((metric, i) => {
        const line = metricLine(metric, data, opts);
        return (
          // On a phone a day has room for its big number only; the day card has the rest.
          <div
            key={metric}
            className={`${i === 0 ? "mt-1 " : ""}hidden text-[0.6875rem] break-words text-slate-400 sm:block`}
            title={line.title}
            data-metric={metric}
          >
            {line.tag ? `${line.tag} ${line.value}` : line.value}
          </div>
        );
      })}
      <div className={`mt-2 h-1 w-full rounded ${NIGHT_COLOR_CLASS[shown]}`} data-color={shown} />
    </button>
  );
}
