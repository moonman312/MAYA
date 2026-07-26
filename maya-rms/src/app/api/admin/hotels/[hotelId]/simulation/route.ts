import { setHotelSimulationMode } from "@/lib/admin/hotels";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * PATCH /api/admin/hotels/[hotelId]/simulation
 * Body: { simulationMode: boolean }
 *   true  → simulation (compute + display only; no PMS writes)
 *   false → live (scheduled job pushes computed rates to the PMS)
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ hotelId: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
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
    await setHotelSimulationMode(ctx.admin, hotelId, body.simulationMode);
    return NextResponse.json({ ok: true, simulationMode: body.simulationMode });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}
