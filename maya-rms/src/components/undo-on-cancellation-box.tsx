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

/** What the rules table says when a box didn't save. */
export const UNDO_BOX_NOT_SAVED = "That didn't save. Try again.";

/**
 * Save a saved rule's box (PUT /api/rules/[id], not an edit). null when it
 * saved; otherwise what to tell the person: the route's reason when their
 * role can't change rules (403), a plain retry line for anything else.
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

/** The rules table's box for one saved rule, and why its last change didn't save. */
export function UndoOnCancellationToggle({
  ruleName,
  checked,
  disabled = false,
  error = null,
  onToggle,
}: {
  ruleName: string;
  checked: boolean;
  disabled?: boolean;
  error?: string | null;
  onToggle: () => void;
}) {
  return (
    <div>
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
      {error ? (
        <p role="alert" className="mt-0.5 text-[11px] text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
