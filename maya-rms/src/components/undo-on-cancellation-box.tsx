"use client";

/**
 * The undo box: "Undo the change if cancellations mean this rule is no
 * longer true" (Jake, 2026-09-25). One option on every rule, the same for a
 * raise or a cut and for every kind of condition, ticked on every new rule.
 * The rule builder shows it in full under the rate adjustment; the rules
 * table shows its short form under the on/off switch, where it can be
 * changed without editing the rule. What it does sits behind the "?".
 */

import { RoomCountHelp } from "@/components/room-type-settings";
import {
  UNDO_ON_CANCELLATION_HELP,
  UNDO_ON_CANCELLATION_LABEL,
  UNDO_ON_CANCELLATION_SHORT,
} from "@/lib/rule-form";

/** The builder's box, in full. */
export function UndoOnCancellationField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 rounded border-slate-600"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-sm text-slate-300">{UNDO_ON_CANCELLATION_LABEL}</span>
      </label>
      <span className="mt-0.5">
        <RoomCountHelp {...UNDO_ON_CANCELLATION_HELP} />
      </span>
    </div>
  );
}

/** The rules table's box for one saved rule. */
export function UndoOnCancellationToggle({
  ruleName,
  checked,
  disabled = false,
  onToggle,
}: {
  ruleName: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400">
        <input
          type="checkbox"
          className="rounded border-slate-600"
          checked={checked}
          disabled={disabled}
          aria-label={`${UNDO_ON_CANCELLATION_LABEL}: ${ruleName}`}
          onChange={onToggle}
        />
        {UNDO_ON_CANCELLATION_SHORT}
      </label>
      <RoomCountHelp {...UNDO_ON_CANCELLATION_HELP} />
    </div>
  );
}
