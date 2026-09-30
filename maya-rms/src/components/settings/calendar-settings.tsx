"use client";

import { useRef, useState } from "react";
import { RoomCountHelp } from "@/components/room-type-settings";
import { track } from "@/lib/analytics/track";
import {
  CALENDAR_METRICS,
  METRIC_LABELS,
  applyDisplayPatch,
  usesPrice,
  withSlot,
  type CalendarColors,
  type CalendarDisplay,
  type CalendarDisplayPatch,
  type CalendarMetric,
} from "@/lib/calendar-display";
import { Choice, SELECT_CLASS, SettingRow, SettingsSection, type SaveState } from "./settings-section";

export type RoomTypeChoice = { id: string; name: string; counts_as_room?: boolean | null };

export const COLOURS_HELP = {
  label: "What Reversed changes",
  title: "Standard or Reversed",
  lines: [
    "Standard: green is a strong night, red a weak one.",
    "Reversed: green is a weak night worth working on, red a strong night you can leave.",
    "Amber is a typical night in both. The colours still compare each night's revenue per room with your own nights.",
  ],
};

/**
 * Settings, Calendar: what each day shows and how its colours read, for
 * everyone on the property. Each change saves at once and the calendar
 * behind shows it; a save that fails puts the choice back.
 */
export function CalendarSettings({
  initial,
  canEdit,
  readOnly,
  propertyName,
  roomTypes,
  hotelId,
  onSaved,
}: {
  initial: CalendarDisplay;
  canEdit: boolean;
  readOnly: string | null;
  propertyName: string | null;
  roomTypes: RoomTypeChoice[];
  hotelId: string | null;
  onSaved: (display: CalendarDisplay) => void;
}) {
  const [draft, setDraft] = useState<CalendarDisplay>(initial);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  // What the database holds, as the newest save that succeeded answered it.
  const saved = useRef<CalendarDisplay>(initial);
  const savedSeq = useRef(0);
  const seq = useRef(0);
  const inFlight = useRef(0);

  /**
   * Sends only what changed; the server lays it over what is saved and
   * answers the whole display. The screen shows the change at once, then
   * what the database holds once no save is still on its way.
   */
  async function save(patch: CalendarDisplayPatch) {
    let next = applyDisplayPatch(draft, patch);
    // A price line needs a room type: the first one that counts as a room, until the owner picks.
    if (usesPrice(next) && !roomTypes.some((r) => r.id === next.price_room_type_id)) {
      const first = roomTypes.find((r) => r.counts_as_room !== false) ?? roomTypes[0];
      patch = { ...patch, price_room_type_id: first?.id ?? null };
      next = { ...next, price_room_type_id: first?.id ?? null };
    }
    setDraft(next);
    setState({ kind: "saving" });
    const mine = ++seq.current;
    inFlight.current += 1;
    let answer: CalendarDisplay | null = null;
    let failure: string | null = null;
    try {
      const res = await fetch("/api/settings/calendar", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as { calendar?: CalendarDisplay; error?: string };
      if (res.ok && body.calendar) answer = body.calendar;
      else failure = body.error ?? "Could not save. Try again in a moment.";
    } catch {
      failure = "Could not save. Check your connection and try again.";
    }
    inFlight.current -= 1;
    // A save that succeeded is what the database held when it answered, even
    // when a later one has been sent since; only a newer answer replaces it.
    if (answer && mine > savedSeq.current) {
      savedSeq.current = mine;
      saved.current = answer;
      onSaved(answer);
    }
    const newest = mine === seq.current;
    if (newest || inFlight.current === 0) setDraft(saved.current);
    if (!newest) return;
    if (failure) {
      setState({ kind: "error", message: failure });
      return;
    }
    setState({ kind: "saved" });
    track("settings.calendar_saved", { big: saved.current.big, small_lines: saved.current.small.length, colors: saved.current.colors }, hotelId);
  }

  const disabled = !canEdit;
  const noRoomTypes = roomTypes.length === 0;
  const metricOptions = (slot: "big" | 0 | 1) =>
    CALENDAR_METRICS.map((m) => (
      <option key={m} value={m} disabled={m === "price" && noRoomTypes}>
        {METRIC_LABELS[m]}
      </option>
    )).concat(slot === "big" ? [] : [<option key="none" value="">None</option>]);

  const onSlot = (slot: "big" | 0 | 1) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    const { big, small } = withSlot(draft, slot, v === "" ? null : (v as CalendarMetric));
    void save({ big, small });
  };

  return (
    <SettingsSection
      id="settings-calendar"
      title="Calendar"
      scope={`For everyone on ${propertyName ?? "this property"}`}
      state={state}
      readOnly={readOnly}
    >
      <SettingRow label="Big number" htmlFor="settings-big">
        <select id="settings-big" className={SELECT_CLASS} value={draft.big} disabled={disabled} onChange={onSlot("big")}>
          {metricOptions("big")}
        </select>
      </SettingRow>
      <SettingRow label="First small line" htmlFor="settings-small-1">
        <select id="settings-small-1" className={SELECT_CLASS} value={draft.small[0] ?? ""} disabled={disabled} onChange={onSlot(0)}>
          {metricOptions(0)}
        </select>
      </SettingRow>
      <SettingRow label="Second small line" htmlFor="settings-small-2">
        <select
          id="settings-small-2"
          className={SELECT_CLASS}
          value={draft.small[1] ?? ""}
          disabled={disabled || draft.small.length === 0}
          onChange={onSlot(1)}
        >
          {metricOptions(1)}
        </select>
      </SettingRow>
      {usesPrice(draft) ? (
        <SettingRow label="Price for" htmlFor="settings-price-room-type">
          <select
            id="settings-price-room-type"
            className={SELECT_CLASS}
            value={roomTypes.some((r) => r.id === draft.price_room_type_id) ? (draft.price_room_type_id ?? "") : ""}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value) void save({ price_room_type_id: e.target.value });
            }}
          >
            {roomTypes.some((r) => r.id === draft.price_room_type_id) ? null : <option value="">Pick a room type</option>}
            {roomTypes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </SettingRow>
      ) : null}
      <SettingRow
        label={
          <>
            Colours
            <RoomCountHelp {...COLOURS_HELP} docs="settings-colours" />
          </>
        }
      >
        <Choice<CalendarColors>
          name="Colours"
          options={[
            { value: "standard", label: "Standard" },
            { value: "reversed", label: "Reversed" },
          ]}
          value={draft.colors}
          disabled={disabled}
          onChange={(colors) => void save({ colors })}
        />
      </SettingRow>
    </SettingsSection>
  );
}
