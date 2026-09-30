/**
 * PUT /api/settings/pms: what MAYA does when a price it sent is changed or
 * removed in the property system, for everyone on the property. Body:
 * { mode: "keep" | "maya_wins", replace?: boolean }.
 *
 * Revenue Manager and up (can_manage_hotel, as rules and manual prices),
 * checked here and again by set_pms_rate_changes under the person's own
 * session; a platform admin saves only in God Mode, and the database records
 * that save for the change log. Turning "MAYA's price wins" on while future
 * nights keep a rate changed in the PMS answers 409 with how many nights,
 * and saves nothing until the same request comes back with replace: true.
 * When nights were handed back, the property's sync is nudged so MAYA's
 * prices go out now rather than within five minutes.
 */

import { NOT_READY_YET } from "@/lib/api-guards";
import { nudgeHotelSync } from "@/lib/pms/sync-nudge";
import { isPmsRateChangeMode, savePmsRateChanges } from "@/lib/settings/pms-settings";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { NextResponse } from "next/server";
import { PROPERTY_SETTINGS_FORBIDDEN, propertyEditRefusal, readBody, settingsContext } from "../gate";

const COULD_NOT_SAVE = "Could not save this setting. Try again in a moment.";

export async function PUT(req: Request) {
  const ctx = await settingsContext();
  if (!ctx.ok) return ctx.response;

  const refusal = await propertyEditRefusal(ctx);
  if (refusal) return NextResponse.json({ error: refusal, code: "forbidden" }, { status: 403 });

  const body = (await readBody(req)) as { mode?: unknown; replace?: unknown } | null;
  if (!body || !isPmsRateChangeMode(body.mode)) {
    return NextResponse.json({ error: "Pick one of the two choices." }, { status: 400 });
  }

  const saved = await savePmsRateChanges(ctx.supabase, ctx.hotelId, body.mode, body.replace === true);
  if (saved.ok) {
    let sending: "nudged" | "next_cycle" | null = null;
    if (saved.replaced > 0) sending = isAdminConfigured() ? await nudgeHotelSync(createAdminClient(), ctx.hotelId) : "next_cycle";
    return NextResponse.json({ mode: saved.mode, replaced: saved.replaced, ...(sending ? { sending } : {}) });
  }

  switch (saved.reason) {
    case "confirm":
      return NextResponse.json({ confirm: { nights: saved.nights } }, { status: 409 });
    case "refused":
      return NextResponse.json({ error: PROPERTY_SETTINGS_FORBIDDEN, code: "forbidden" }, { status: 403 });
    case "pre_migration":
    case "no_row":
      console.error(JSON.stringify({ fn: "settings/pms", hotelId: ctx.hotelId, reason: saved.reason, error: saved.message }));
      return NextResponse.json({ error: NOT_READY_YET }, { status: 503 });
    default:
      console.error(JSON.stringify({ fn: "settings/pms", hotelId: ctx.hotelId, reason: saved.reason, error: saved.message }));
      return NextResponse.json({ error: COULD_NOT_SAVE }, { status: 500 });
  }
}
