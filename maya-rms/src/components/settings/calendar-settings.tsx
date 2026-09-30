"use client";

import { useRef, useState } from "react";
import { RoomCountHelp } from "@/components/room-type-settings";
import { track } from "@/lib/analytics/track";
import {
  CALENDAR_METRICS,
  METRIC_LABELS,
  usesPrice,
  withSlot,
  type CalendarColors,
  type CalendarDisplay,
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
  const saved = useRef<CalendarDisplay>(initial);
  const seq = useRef(0);

  async function save(next: CalendarDisplay) {
    // A price line needs a room type: the first one that counts as a room, until the owner picks.
    if (usesPrice(next) && !roomTypes.some((r) => r.id === next.price_room_type_id)) {
      const first = roomTypes.find((r) => r.counts_as_room !== false) ?? roomTypes[0];
      next = { ...next, price_room_type_id: first?.id ?? null };
    }
    setDraft(next);
    setState({ kind: "saving" });
    const mine = ++seq.current;
    try {
      const res = await fetch("/api/settings/calendar", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await res.json().catch(() => ({}))) as { calendar?: CalendarDisplay; error?: string };
      if (mine !== seq.current) return;
      if (!res.ok || !body.calendar) {
        setDraft(saved.current);
        setState({ kind: "error", message: body.error ?? "Could not save. Try again in a moment." });
        return;
      }
      saved.current = body.calendar;
      setDraft(body.calendar);
      setState({ kind: "saved" });
      onSaved(body.calendar);
      track(
        "settings.calendar_saved",
        { big: body.calendar.big, small_lines: body.calendar.small.length, colors: body.calendar.colors },
        hotelId,
      );
    } catch {
      if (mine !== seq.current) return;
      setDraft(saved.current);
      setState({ kind: "error", message: "Could not save. Check your connection and try again." });
    }
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
    void save(withSlot(draft, slot, v === "" ? null : (v as CalendarMetric)));
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
              if (e.target.value) void save({ ...draft, price_room_type_id: e.target.value });
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
          onChange={(colors) => void save({ ...draft, colors })}
        />
      </SettingRow>
    </SettingsSection>
  );
}
