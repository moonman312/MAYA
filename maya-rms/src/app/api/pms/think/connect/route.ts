import { buildAuthorizeRedirect } from "@/lib/pms/oauth-flow";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hotelId = url.searchParams.get("hotelId");
  if (!hotelId) {
    return NextResponse.json({ error: "hotelId query param required" }, { status: 400 });
  }
  return buildAuthorizeRedirect(await cookies(), "think", { kind: "hotel", hotelId });
}
