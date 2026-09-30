import { GodModeBannerSlot } from "@/components/admin/god-mode-banner-slot";
import { Dashboard, type SupportView } from "@/components/dashboard";
import { godModeStatus } from "@/lib/admin/god-mode";
import { memberRole } from "@/lib/deep-links/member-role";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { readTextSize } from "@/lib/settings/profile-settings";
import type { TextSize } from "@/lib/text-size";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let isPlatformAdmin = false;
  let supportView: SupportView = null;
  let textSize: TextSize | null = null;

  if (isSupabaseConfigured()) {
    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      redirect("/login");
    }

    // Command Center had no entry point anywhere in the app — a platform
    // admin had to know the URL. Surface it only to those who can use it.
    // Resolved before the redirect below, which needs to know.
    // The text size saved on their profile rides along, so a browser that
    // shows another one (a new device, someone else's cookie) is put right.
    const [{ data: admin }, savedTextSize] = await Promise.all([
      supabase.rpc("is_platform_admin", { p_user_id: user.id }),
      readTextSize(supabase, user.id),
    ]);
    isPlatformAdmin = Boolean(admin);
    textSize = savedTextSize;

    // Now that the PMS is connected before anyone picks a path, no property
    // means onboarding is genuinely unfinished — there is no way to legitimately
    // be here without one. It used to be possible: "let me drive" came before
    // the connect step and stamped onboarding as dismissed, which parked people
    // on a dashboard with nothing in it and no route back.
    //
    // Except for us: membership is what resolveAccessibleHotelId reads, and
    // platform admins have none, so this would send Jake and Corey to a payment
    // form for a property they were never buying.
    const hotelId = await resolveAccessibleHotelId(supabase);
    if (!hotelId) {
      redirect(isPlatformAdmin ? "/admin" : "/onboarding");
    }

    // A platform admin on a property they do not belong to is a Viewer
    // unless God Mode is on: the database refuses their writes either way,
    // and the dashboard says which it is.
    if (isPlatformAdmin && !(await memberRole(supabase, user.id, hotelId))) {
      supportView = (await godModeStatus(supabase)).active ? "god_mode" : "read_only";
    }
  }

  // The tab and place the address asks for (and anything a link brought),
  // so the first paint is already the right screen. The dashboard checks
  // every value itself; this only carries the query across.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const initialSearch = query.size ? `?${query.toString()}` : "";

  return (
    <>
      <Dashboard isPlatformAdmin={isPlatformAdmin} supportView={supportView} initialSearch={initialSearch} textSize={textSize} />
      <GodModeBannerSlot isPlatformAdmin={isPlatformAdmin} />
    </>
  );
}
