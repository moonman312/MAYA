import { recordSupportChange, requireGodMode } from "@/lib/admin/god-mode";
import { setHotelSimulationMode } from "@/lib/admin/hotels";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * PATCH /api/admin/hotels/[hotelId]/simulation
 * Body: { simulationMode: boolean }
 *   true  → simulation (compute + display only; no PMS writes)
 *   false → live (scheduled job pushes computed rates to the PMS)
 *
 * A hotel edit, so it needs God Mode. The platform admin who made the change
 * and their window are recorded on the hotel.simulation_mode_changed audit
 * event (detail.actor_user_id, detail.god_mode_session_id) and as a
 * support_changes row the property's change log shows.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ hotelId: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const god = await requireGodMode(ctx.ssr);
  if (!god.ok) return god.response;
  const { hotelId } = await params;

  let body: { simulationMode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.simulationMode !== "boolean") {
    return NextResponse.json(
      { error: "simulationMode (boolean) is required" },
      { status: 400 },
    );
  }

  try {
    await setHotelSimulationMode(ctx.admin, hotelId, body.simulationMode, ctx.user.id, god.session.id);
    await recordSupportChange(ctx.admin, {
      sessionId: god.session.id,
      userId: ctx.user.id,
      hotelId,
      tableName: "hotel_settings",
      rowId: hotelId,
      op: "update",
      after: { simulation_mode: body.simulationMode },
      summary: body.simulationMode ? "Switched pricing back to simulation." : "Took pricing live.",
    });
    return NextResponse.json({ ok: true, simulationMode: body.simulationMode });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}
