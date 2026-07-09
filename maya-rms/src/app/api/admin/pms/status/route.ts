import { listPmsStatuses } from "@/lib/pms/registry";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Reports which PMS integrations are configured on this deployment. Consumed
 * by /admin UI to render Connect vs "not configured" badges without exposing
 * env vars to the client.
 */
export async function GET() {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  return NextResponse.json({ statuses: listPmsStatuses() });
}
