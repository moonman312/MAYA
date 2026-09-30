"use client";

import { useEffect, useRef, useState } from "react";
import { HelpLink } from "@/components/deep-links/help-links";
import { useTrackOnce } from "@/lib/analytics/track";
import type { CalendarDisplay } from "@/lib/calendar-display";
import { currentTextSize } from "@/lib/text-size";
import { CalendarSettings, type RoomTypeChoice } from "./calendar-settings";
import { DisplaySettings } from "./display-settings";

/** What GET /api/settings answers: one key per section. */
export type SettingsPayload = {
  property: { canEdit: boolean; readOnly: string | null };
  calendar: CalendarDisplay;
  textSize: string | null;
};

/**
 * Settings, opened from the gear in the dashboard header. One section after
 * another, each saying who it is for: the property-wide ones first (only
 * roles that can manage the property may change them; everyone else sees
 * them read-only), then the signed-in person's own. A new section is one
 * more component in the list below, fed from its own key in the payload.
 */
export function SettingsDialog({
  onClose,
  hotelId,
  propertyName,
  roomTypes,
  calendar,
  onCalendarSaved,
}: {
  onClose: () => void;
  hotelId: string | null;
  propertyName: string | null;
  roomTypes: RoomTypeChoice[];
  /** The property's choices as the calendar last loaded them: shown until the fresh read lands. */
  calendar: CalendarDisplay;
  onCalendarSaved: (display: CalendarDisplay) => void;
}) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [textSize] = useState(currentTextSize);

  useTrackOnce("settings.opened", {}, hotelId);

  // Read through a ref, so a parent re-rendering (the calendar refreshing
  // behind) never moves the focus back to Close.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as SettingsPayload;
        if (alive) setPayload(body);
      } catch {
        if (alive) setLoadError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hotelId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4 sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="settings-title" className="text-lg font-semibold text-slate-100">
            Settings
          </h2>
          <div className="flex items-center gap-3">
            <HelpLink screen="settings" className="text-xs text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-slate-200" />
            <button
              ref={closeRef}
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="cursor-pointer rounded px-1.5 text-xl leading-none text-slate-400 hover:text-slate-200"
            >
              ×
            </button>
          </div>
        </div>
        {loadError ? (
          <p role="alert" className="mt-3 text-xs text-rose-300">
            Couldn&apos;t load your settings. Close this and try again in a moment.
          </p>
        ) : null}
        <div className="mt-4 space-y-5">
          <CalendarSettings
            // Filled again once the fresh read lands, so its first save starts from what is saved.
            key={payload ? "loaded" : "loading"}
            initial={payload?.calendar ?? calendar}
            canEdit={payload?.property.canEdit === true}
            readOnly={payload ? payload.property.readOnly : null}
            propertyName={propertyName}
            roomTypes={roomTypes}
            hotelId={hotelId}
            onSaved={onCalendarSaved}
          />
          <DisplaySettings initial={textSize} hotelId={hotelId} />
        </div>
      </div>
    </div>
  );
}
