/**
 * Assumption challenges — the owner's lever over the observation engine.
 *
 * GET  → every challenge on file plus where each stands: applied instantly
 *        (the flagged date), pending corroboration (needs more years), or
 *        promoted to a recurring window. The transparency half of the loop.
 * POST → raise a challenge. The flagged date stops being comparable on the
 *        next evaluation; nothing generalizes beyond it without multi-year
 *        corroboration (see observations/reinforcement.ts).
 */

import { dbErrorResponse, isRealIsoDate } from "@/lib/api-guards";
import {
  CHALLENGE_REASONS,
  buildReinforcementModel,
  challengeReasonLabel,
  describeInstanceExclusion,
  describePendingProgress,
  describePromotedWindow,
  isKnownChallengeReason,
  type AssumptionChallenge,
  type ChallengeScope,
} from "@/lib/observations/reinforcement";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const OTHER_TEXT_MAX = 300;

async function loadChallenges(supabase: SupabaseClient, hotelId: string) {
  const { data, error } = await supabase
    .from("assumption_challenges")
    .select("id, challenged_date, reason_key, other_text, scope, created_at")
    .eq("hotel_id", hotelId)
    .order("challenged_date", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).filter((c) => isKnownChallengeReason(String(c.reason_key)));
}

function summarize(rows: Awaited<ReturnType<typeof loadChallenges>>) {
  const challenges: AssumptionChallenge[] = rows.map((c) => ({
    id: String(c.id),
    date: String(c.challenged_date),
    reasonKey: String(c.reason_key),
    otherText: c.other_text != null ? String(c.other_text) : undefined,
    scope: String(c.scope) as ChallengeScope,
    raisedAt: String(c.created_at).slice(0, 10),
  }));
  const model = buildReinforcementModel(challenges, {
    now: new Date().toISOString().slice(0, 10),
  });
  return {
    challenges: challenges.map((c) => ({
      id: c.id,
      date: c.date,
      reason_key: c.reasonKey,
      reason_label: challengeReasonLabel(c.reasonKey),
      other_text: c.otherText ?? null,
      scope: c.scope,
      description: describeInstanceExclusion(c.reasonKey, c.otherText),
    })),
    pending: model.pending.map((p) => ({
      reason_key: p.reasonKey,
      scope: p.scope,
      dates: p.dates,
      description: describePendingProgress(p),
    })),
    promoted: model.promotedAnnualWindows.map((w) => ({
      reason_key: w.reasonKey,
      scope: w.scope,
      supporting_dates: w.supportingDates,
      description: describePromotedWindow(w),
    })),
  };
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({ error: "No hotel" }, { status: 400 });
  }
  try {
    return NextResponse.json(summarize(await loadChallenges(supabase, hotelId)));
  } catch (e) {
    const { status, message } = dbErrorResponse(e);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({ error: "No hotel" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    date?: string;
    reason_key?: string;
    other_text?: string;
    scope?: string;
  } | null;
  const date = body?.date ?? "";
  const reasonKey = body?.reason_key ?? "";
  const otherText = body?.other_text?.trim() || null;
  const scope = (body?.scope ?? "this_date") as ChallengeScope;

  if (!isRealIsoDate(date)) {
    return NextResponse.json({ error: "That is not a real calendar date" }, { status: 400 });
  }
  const reason = CHALLENGE_REASONS.find((r) => r.key === reasonKey);
  if (!reason) {
    return NextResponse.json({ error: "Unknown reason" }, { status: 400 });
  }
  if (!reason.suggestedScopes.includes(scope)) {
    return NextResponse.json(
      { error: `"${reason.label}" cannot be generalized that far — flag just the date instead` },
      { status: 400 },
    );
  }
  if (reasonKey === "other" && !otherText) {
    return NextResponse.json({ error: `"Other" needs a short explanation` }, { status: 400 });
  }
  if (otherText && otherText.length > OTHER_TEXT_MAX) {
    return NextResponse.json(
      { error: `Keep the explanation under ${OTHER_TEXT_MAX} characters` },
      { status: 400 },
    );
  }

  const { error } = await supabase.from("assumption_challenges").insert({
    hotel_id: hotelId,
    challenged_date: date,
    reason_key: reasonKey,
    other_text: otherText,
    scope,
    raised_by: user.id,
  });
  if (error) {
    // 23505 = the unique index: this exact flag already exists.
    if (error.code === "23505") {
      return NextResponse.json({ error: "You have already flagged this date for that reason" }, { status: 409 });
    }
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }

  try {
    return NextResponse.json(summarize(await loadChallenges(supabase, hotelId)));
  } catch {
    return NextResponse.json({ ok: true });
  }
}
