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

/** What to say when a saved rule's box didn't save. */
export const UNDO_BOX_NOT_SAVED = "That didn't save. Try again.";

/**
 * Save a saved rule's box (PUT /api/rules/[id], not an edit), kept for
 * rule editing. null when it saved; otherwise what to tell the person: the
 * route's reason when their role can't change rules (403), a plain retry
 * line for anything else.
 */
export async function saveUndoOnCancellation(
  ruleId: string,
  value: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`/api/rules/${ruleId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ undo_on_cancellation: value }),
    });
    if (res.ok) return null;
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (typeof body?.error === "string") return body.error;
    }
    return UNDO_BOX_NOT_SAVED;
  } catch {
    return UNDO_BOX_NOT_SAVED;
  }
}
