/**
 * GET /api/settings: everything the Settings area shows, in one read when it
 * opens. One key per section:
 *
 *   property  whether this person may change the property-wide sections
 *             (canEdit), and if not, the sentence that says why (readOnly)
 *   calendar  the property's calendar choices (hotel_settings.calendar_*)
 *   textSize  this person's own text size (profiles.text_size)
 *
 * A new section adds its own key here and its own route beside this one for
 * saving (./calendar, ./display).
 */

import { DEFAULT_CALENDAR_DISPLAY } from "@/lib/calendar-display";
import { readCalendarDisplay } from "@/lib/settings/calendar-settings";
import { readTextSize } from "@/lib/settings/profile-settings";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { NextResponse } from "next/server";
import { SETTINGS_NEED_A_PROPERTY, propertyEditRefusal, settingsContext } from "./gate";

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({
      property: { canEdit: false, readOnly: SETTINGS_NEED_A_PROPERTY },
      calendar: DEFAULT_CALENDAR_DISPLAY,
      textSize: null,
    });
  }
  const ctx = await settingsContext();
  if (!ctx.ok) return ctx.response;

  const [refusal, calendar, textSize] = await Promise.all([
    propertyEditRefusal(ctx),
    readCalendarDisplay(ctx.supabase, ctx.hotelId),
    readTextSize(ctx.supabase, ctx.userId),
  ]);

  return NextResponse.json({
    property: { canEdit: refusal === null, readOnly: refusal },
    calendar,
    textSize,
  });
}
