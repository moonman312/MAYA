/**
 * Whether the signed-in person still has to accept the current Terms of
 * Service and Privacy Policy (GET), and recording that they did (POST).
 *
 * New accounts almost never need either: the signup form carries the tick in
 * the user metadata and the database turns it into a row as the user is
 * created. This route is for everyone else: an invite accepted on its own
 * form, and an existing user asked once by the accept screen
 * (components/legal/terms-gate.tsx).
 *
 * GET answers "not required" whenever it cannot be sure. The accept screen
 * sits in front of the whole app, and a hotel locked out of its pricing by a
 * missing table or a slow database is a worse outcome than asking again
 * tomorrow. Every such case is logged.
 */

import {
  adoptSignupAcceptance,
  currentAcceptance,
  recordAcceptance,
  requestIp,
  requestUserAgent,
} from "@/lib/legal/acceptance";
import {
  metadataAcceptsCurrent,
  PRIVACY_VERSION,
  TERMS_VERSION,
  type AcceptanceContext,
} from "@/lib/legal/versions";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notRequired = () =>
  NextResponse.json(
    { required: false, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
    { headers: { "Cache-Control": "no-store" } },
  );

/** Only these are recorded here; signup and claim arrive through the metadata trigger. */
const ROUTE_CONTEXTS: ReadonlySet<AcceptanceContext> = new Set(["invite", "reaccept"]);

export async function GET() {
  if (!isSupabaseConfigured()) return notRequired();

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return notRequired();

  const state = await currentAcceptance(supabase, user.id);
  if (state !== "missing") return notRequired();

  // They ticked the box at signup but the trigger did not write the row.
  if (metadataAcceptsCurrent(user.user_metadata) && isAdminConfigured()) {
    if (await adoptSignupAcceptance(createAdminClient(), user.id)) return notRequired();
  }

  // MHS staff are the provider, not a customer agreeing to its terms.
  const { data: isPlatformAdmin } = await supabase.rpc("is_platform_admin", {
    p_user_id: user.id,
  });
  if (isPlatformAdmin === true) return notRequired();

  return NextResponse.json(
    { required: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    accepted?: unknown;
    context?: unknown;
    termsVersion?: unknown;
    privacyVersion?: unknown;
  } | null;

  // An explicit true, not merely a request: the record says they ticked it.
  if (body?.accepted !== true) {
    return NextResponse.json({ error: "Tick the box to agree." }, { status: 400 });
  }
  const context = body.context as AcceptanceContext;
  if (!ROUTE_CONTEXTS.has(context)) {
    return NextResponse.json({ error: "Unknown acceptance." }, { status: 400 });
  }
  // A tab left open across a release showed the person older wording than the
  // version this server would write down.
  if (body.termsVersion !== TERMS_VERSION || body.privacyVersion !== PRIVACY_VERSION) {
    return NextResponse.json(
      { error: "The terms have been updated. Reload the page to see them.", reason: "stale_version" },
      { status: 409 },
    );
  }

  if (!isAdminConfigured()) {
    console.error(
      JSON.stringify({
        fn: "termsAcceptance",
        step: "post",
        warning: "SUPABASE_SERVICE_ROLE_KEY is not set, acceptance is NOT being recorded",
      }),
    );
    return NextResponse.json({ ok: true, recorded: false });
  }

  let hotelId: string | null = null;
  try {
    hotelId = await resolveAccessibleHotelId(supabase);
  } catch {
    // The property is context for the record, not a condition of it.
  }

  const result = await recordAcceptance(createAdminClient(), {
    userId: user.id,
    email: user.email ?? null,
    context,
    hotelId,
    ip: requestIp(request.headers),
    userAgent: requestUserAgent(request.headers),
  });

  if (result === "failed") {
    return NextResponse.json(
      { error: "We couldn't save that just now. Please try again." },
      { status: 503 },
    );
  }
  // "unavailable" is the migration not having run: say so to the log (already
  // done) and let them through rather than trap them behind a screen that can
  // never succeed.
  return NextResponse.json({ ok: true, recorded: result === "recorded" || result === "duplicate" });
}
