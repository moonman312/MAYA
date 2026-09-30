/**
 * PUT /api/settings/display: the signed-in person's own display choices.
 * Body: { textSize: "standard" | "large" | "larger" }.
 *
 * Saved on their profile, so it follows them to any device. The browser
 * already shows the new size and keeps it in a cookie for its next page
 * load (lib/text-size); this is the copy that travels.
 */

import { NOT_READY_YET } from "@/lib/api-guards";
import { saveTextSize } from "@/lib/settings/profile-settings";
import { isTextSize } from "@/lib/text-size";
import { NextResponse } from "next/server";
import { readBody, settingsContext } from "../gate";

export async function PUT(req: Request) {
  const ctx = await settingsContext();
  if (!ctx.ok) return ctx.response;

  const body = (await readBody(req)) as { textSize?: unknown } | null;
  const size = body?.textSize;
  if (!isTextSize(size)) return NextResponse.json({ error: "Pick Standard, Large or Larger." }, { status: 400 });

  const saved = await saveTextSize(ctx.supabase, ctx.userId, size);
  if (saved.ok) return NextResponse.json({ textSize: size });

  console.error(JSON.stringify({ fn: "settings/display", reason: saved.reason, error: saved.message }));
  if (saved.reason === "failed") {
    return NextResponse.json({ error: "Could not save your text size. Try again in a moment." }, { status: 500 });
  }
  return NextResponse.json({ error: NOT_READY_YET }, { status: 503 });
}
