import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { flagSignupAbandoned, SignupFlagError } from "@/lib/admin/stalled-signups";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * PATCH — mark a stalled signup as one we've given up on, or put it back.
 *
 * The flag only hides the row from the default list. Nothing here cancels a
 * subscription, refunds anything, or touches the hotel: those are decisions with
 * money attached and they belong in Stripe, not behind a button on a triage list.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ hotelId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const { hotelId } = await params;

  let body: { abandoned?: unknown; note?: unknown };
  try {
    body = (await req.json()) as { abandoned?: unknown; note?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.abandoned !== "boolean") {
    return NextResponse.json({ error: "abandoned must be true or false." }, { status: 400 });
  }
  if (body.note != null && typeof body.note !== "string") {
    return NextResponse.json({ error: "note must be text." }, { status: 400 });
  }

  try {
    await flagSignupAbandoned(ctx.ssr, hotelId, body.abandoned, (body.note as string) ?? null);
    return NextResponse.json({ ok: true, abandoned: body.abandoned });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update the signup";
    // P0002 is the RPC's own "no such hotel" — a 404 rather than a 400, because
    // the request was fine and the row is what's missing.
    const status = error instanceof SignupFlagError && error.code === "P0002" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
