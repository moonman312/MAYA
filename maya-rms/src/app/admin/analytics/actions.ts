"use server";

import { updateTag } from "next/cache";
import { cookies } from "next/headers";
import { snapshotHotelMetrics } from "@/lib/admin/analytics";
import { ANALYTICS_CACHE_TAG } from "@/lib/admin/analytics-cache";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";

type RefreshResult = { ok: true } | { ok: false; error: string };

/**
 * The analytics page's Refresh: today's snapshot row written again, then every
 * kept section thrown away, so the page comes back worked out from now.
 * Anyone can call a Server Action, so it checks for a platform admin itself,
 * the full way (the Auth server, then the role), like the routes that change
 * things.
 */
export async function refreshAnalytics(): Promise<RefreshResult> {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return { ok: false, error: "Only a platform admin can refresh these numbers." };
  try {
    await snapshotHotelMetrics(ctx.admin, new Date().toISOString().slice(0, 10));
  } catch (e) {
    // Only today's point waits for the next write; everything else still refreshes.
    console.error(JSON.stringify({ fn: "analyticsRefreshSnapshot", error: e instanceof Error ? e.message : String(e) }));
  }
  updateTag(ANALYTICS_CACHE_TAG);
  return { ok: true };
}
