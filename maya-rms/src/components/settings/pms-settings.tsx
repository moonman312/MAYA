"use client";

import { useRef, useState } from "react";
import { RoomCountHelp } from "@/components/room-type-settings";
import { track } from "@/lib/analytics/track";
import { PMS_CHANGES_LABELS, replaceLine, type PmsRateChangeMode, type PmsSettings } from "@/lib/settings/pms-settings";
import { Choice, SettingsSection, type SaveState } from "./settings-section";

/** The "?" beside the setting. */
export function pmsChangesHelp(pms: string) {
  return {
    label: "What the two choices do",
    title: `Changes made in ${pms}`,
    lines: [
      `Keep the change as your price: a rate changed in ${pms} on a night MAYA sent to becomes your price for that night. A rate removed there stops MAYA pricing the night until ${pms} has a rate again.`,
      `MAYA's price wins: MAYA sends its own price again, lists each night in the Change Log, and emails the General Manager and Hotel Admins at most once a day. For properties that also run another pricing tool.`,
      "To set a price by hand, set it on MAYA's calendar. A price you set there is kept either way.",
    ],
  };
}

/**
 * Settings, the property system's section: what MAYA does when a price it
 * sent is changed in Cloudbeds or ThinkReservations, for everyone on the
 * property. Saves at once, like every section; turning "MAYA's price wins"
 * on while nights keep a rate changed in the PMS asks first, in place, and
 * saves only once the owner says to replace them.
 */
export function PmsSettingsSection({
  initial,
  canEdit,
  readOnly,
  propertyName,
  hotelId,
}: {
  initial: PmsSettings;
  canEdit: boolean;
  readOnly: string | null;
  propertyName: string | null;
  hotelId: string | null;
}) {
  const [mode, setMode] = useState<PmsRateChangeMode>(initial.mode);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [confirm, setConfirm] = useState<{ nights: number } | null>(null);
  const saved = useRef<PmsRateChangeMode>(initial.mode);
  const seq = useRef(0);
  const pms = initial.name;

  async function save(next: PmsRateChangeMode, replace = false) {
    setMode(next);
    setConfirm(null);
    setState({ kind: "saving" });
    const mine = ++seq.current;
    try {
      const res = await fetch("/api/settings/pms", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next, ...(replace ? { replace: true } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { mode?: PmsRateChangeMode; replaced?: number; confirm?: { nights: number }; error?: string };
      if (mine !== seq.current) return;
      if (res.status === 409 && body.confirm) {
        // Nothing is saved yet: the choice goes back until the owner says to replace them.
        setMode(saved.current);
        setState({ kind: "idle" });
        setConfirm(body.confirm);
        return;
      }
      if (!res.ok || !body.mode) {
        setMode(saved.current);
        setState({ kind: "error", message: body.error ?? "Could not save. Try again in a moment." });
        return;
      }
      saved.current = body.mode;
      setMode(body.mode);
      setState({ kind: "saved" });
      track("settings.pms_saved", { mode: body.mode, replaced: body.replaced ?? 0 }, hotelId);
    } catch {
      if (mine !== seq.current) return;
      setMode(saved.current);
      setState({ kind: "error", message: "Could not save. Check your connection and try again." });
    }
  }

  const question = PMS_CHANGES_LABELS.question(pms);
  return (
    <SettingsSection id="settings-pms" title={pms} scope={`For everyone on ${propertyName ?? "this property"}`} state={state} readOnly={readOnly}>
      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
          {question}
          <RoomCountHelp {...pmsChangesHelp(pms)} docs="settings-pms-changes" />
        </p>
        <Choice<PmsRateChangeMode>
          name={question}
          options={[
            { value: "keep", label: PMS_CHANGES_LABELS.keep },
            { value: "maya_wins", label: PMS_CHANGES_LABELS.maya_wins },
          ]}
          value={mode}
          disabled={!canEdit || state.kind === "saving" || confirm != null}
          onChange={(next) => void save(next)}
        />
        {confirm ? (
          <div role="group" aria-label="Replace rates changed in the property system" className="rounded border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-xs leading-relaxed text-amber-100">{replaceLine(confirm.nights, pms)}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void save("maya_wins", true)}
                className="cursor-pointer rounded bg-amber-500/90 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                Replace them
              </button>
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="cursor-pointer rounded px-3 py-1 text-xs text-slate-300 hover:text-slate-100"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
