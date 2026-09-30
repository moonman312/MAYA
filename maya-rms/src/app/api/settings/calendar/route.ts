/**
 * PUT /api/settings/calendar: the property's calendar choices, for everyone
 * on it. Body: only what changed (lib/calendar-display CalendarDisplayPatch):
 * { big, small } for the day's numbers, { price_room_type_id }, { colors },
 * or several of them. It is laid over what is saved, so two people saving
 * different choices at once never undo each other.
 *
 * Revenue Manager and up (can_manage_hotel, as rules and manual prices), and
 * saved through the person's own client, so row level security checks it
 * again. A platform admin saves only in God Mode, and the database records
 * that save for the change log. Answers every calendar choice as saved.
 */

import { NOT_READY_YET } from "@/lib/api-guards";
import { parseDisplayPatch } from "@/lib/calendar-display";
import { saveCalendarDisplay } from "@/lib/settings/calendar-settings";
import { NextResponse } from "next/server";
import { PROPERTY_SETTINGS_FORBIDDEN, propertyEditRefusal, readBody, settingsContext } from "../gate";

const COULD_NOT_SAVE = "Could not save your calendar settings. Try again in a moment.";

export async function PUT(req: Request) {
  const ctx = await settingsContext();
  if (!ctx.ok) return ctx.response;

  const refusal = await propertyEditRefusal(ctx);
  if (refusal) return NextResponse.json({ error: refusal, code: "forbidden" }, { status: 403 });

  const parsed = parseDisplayPatch(await readBody(req));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const saved = await saveCalendarDisplay(ctx.supabase, ctx.hotelId, parsed.patch);
  if (saved.ok) return NextResponse.json({ calendar: saved.display });

  switch (saved.reason) {
    case "room_type":
      return NextResponse.json({ error: saved.message }, { status: 400 });
    case "refused":
      return NextResponse.json({ error: PROPERTY_SETTINGS_FORBIDDEN, code: "forbidden" }, { status: 403 });
    case "pre_migration":
    case "no_row":
      console.error(JSON.stringify({ fn: "settings/calendar", hotelId: ctx.hotelId, reason: saved.reason, error: saved.message }));
      return NextResponse.json({ error: NOT_READY_YET }, { status: 503 });
    default:
      console.error(JSON.stringify({ fn: "settings/calendar", hotelId: ctx.hotelId, reason: saved.reason, error: saved.message }));
      return NextResponse.json({ error: COULD_NOT_SAVE }, { status: 500 });
  }
}
