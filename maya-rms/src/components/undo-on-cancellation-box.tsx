"use client";

/**
 * The undo box: "Undo the change if cancellations mean this rule is no
 * longer true" (Jake, 2026-09-25). One option on every rule, the same for a
 * raise or a cut and for every kind of condition, ticked on every new rule.
 * The rule builder shows it under the rate adjustment, and what it does
 * sits behind the "?". The rules list does not show it (Jake, 2026-09-28),
 * so until rules can be edited it is set when a rule is made.
 */

import { RoomCountHelp } from "@/components/room-type-settings";
import { UNDO_ON_CANCELLATION_HELP, UNDO_ON_CANCELLATION_LABEL } from "@/lib/rule-form";

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
