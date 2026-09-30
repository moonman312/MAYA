"use client";

import { useRef, useState } from "react";
import { track } from "@/lib/analytics/track";
import { TEXT_SIZES, TEXT_SIZE_LABELS, applyTextSize, type TextSize } from "@/lib/text-size";
import { Choice, SettingRow, SettingsSection, type SaveState } from "./settings-section";

export const TEXT_SIZE_NOT_SAVED = "Couldn't save your text size. Try again.";

/**
 * Settings, Display: choices for the signed-in person only. The text size
 * shows at once on this browser and is saved on their profile, so every
 * device they sign in on opens at it.
 */
export function DisplaySettings({ initial, hotelId }: { initial: TextSize; hotelId: string | null }) {
  const [size, setSize] = useState<TextSize>(initial);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const seq = useRef(0);

  async function choose(next: TextSize) {
    setSize(next);
    applyTextSize(next);
    setState({ kind: "saving" });
    const mine = ++seq.current;
    try {
      const res = await fetch("/api/settings/display", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ textSize: next }),
      });
      if (mine !== seq.current) return;
      if (!res.ok) {
        // It still shows on this page, but the next dashboard load goes back to the size on the profile.
        setState({ kind: "error", message: TEXT_SIZE_NOT_SAVED });
        return;
      }
      setState({ kind: "saved" });
      track("settings.text_size_saved", { size: next }, hotelId);
    } catch {
      if (mine !== seq.current) return;
      setState({ kind: "error", message: TEXT_SIZE_NOT_SAVED });
    }
  }

  return (
    <SettingsSection id="settings-display" title="Display" scope="Just for you" state={state}>
      <SettingRow label="Text size">
        <Choice<TextSize>
          name="Text size"
          options={TEXT_SIZES.map((t) => ({ value: t, label: TEXT_SIZE_LABELS[t] }))}
          value={size}
          onChange={(t) => void choose(t)}
        />
      </SettingRow>
    </SettingsSection>
  );
}
