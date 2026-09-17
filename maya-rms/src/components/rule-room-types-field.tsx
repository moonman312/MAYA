"use client";

/**
 * The rule builder's room types. One list by default, used both to measure
 * and to change. Ticking "Change prices on different room types" splits it:
 * the first list becomes what the rule measures, and a second list, starting
 * as a copy, what it changes.
 */

import { RoomCountHelp, isCountingRoom } from "@/components/room-type-settings";
import type { RoomTypeOption } from "@/lib/rule-form";

const SPLIT_HELP = {
  label: "What changing prices on different room types does",
  title: "Measure and change",
  lines: [
    "You watch occupancy, pickup and booking speed on the Measure room types.",
    "When the rule fires, you change prices on the Change room types.",
    "Unticked, one list does both.",
  ],
};

function RoomTypeChips({
  label,
  options,
  selected,
  onSelected,
}: {
  label: string;
  options: RoomTypeOption[];
  selected: string[];
  onSelected: (ids: string[]) => void;
}) {
  const n = options.length;
  const k = options.filter((o) => selected.includes(o.id)).length;
  const summary =
    n === 0 ? "No room types loaded" : k === 0 ? "None selected" : k === n ? "All room types" : `${k} of ${n} room types`;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <p className="text-xs font-medium text-slate-400">{label}</p>
        <span className="text-xs text-slate-500">{summary}</span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="cursor-pointer rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
            onClick={() => onSelected(options.map((r) => r.id))}
          >
            Select all
          </button>
          <button
            type="button"
            className="cursor-pointer rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
            onClick={() => onSelected([])}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const on = selected.includes(opt.id);
          const room = isCountingRoom(opt);
          return (
            <button
              type="button"
              key={opt.id}
              aria-pressed={on}
              className={`cursor-pointer rounded px-2 py-1 text-xs ${on ? "bg-sky-600" : "bg-slate-800"} ${room ? "" : "text-slate-400"}`}
              onClick={() => onSelected(on ? selected.filter((x) => x !== opt.id) : [...selected, opt.id])}
              title={room ? opt.name : `${opt.name}, not counted as a room (change this in the PMS tab)`}
            >
              {opt.name}
              {room ? null : (
                <span className="ml-1.5 rounded bg-slate-950/50 px-1 py-px text-[9px] uppercase tracking-wide text-slate-400">
                  not a room
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RuleRoomTypesField({
  options,
  selected,
  onSelected,
  split,
  onSplit,
  changeIds,
  onChangeIds,
}: {
  options: RoomTypeOption[];
  selected: string[];
  onSelected: (ids: string[]) => void;
  split: boolean;
  onSplit: (split: boolean) => void;
  changeIds: string[];
  onChangeIds: (ids: string[]) => void;
}) {
  return (
    <div className="space-y-3">
      {split ? (
        <>
          <RoomTypeChips
            label="Measure"
            options={options.filter(isCountingRoom)}
            selected={selected}
            onSelected={onSelected}
          />
          <RoomTypeChips label="Change" options={options} selected={changeIds} onSelected={onChangeIds} />
        </>
      ) : (
        <RoomTypeChips label="Apply to room types" options={options} selected={selected} onSelected={onSelected} />
      )}
      <div className="flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            className="rounded border-slate-600"
            checked={split}
            onChange={(e) => {
              if (e.target.checked) onChangeIds(selected.slice());
              onSplit(e.target.checked);
            }}
          />
          Change prices on different room types
        </label>
        <RoomCountHelp {...SPLIT_HELP} />
      </div>
    </div>
  );
}
