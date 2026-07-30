import { Dashboard } from "@/components/dashboard";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function Home() {
  let isPlatformAdmin = false;

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
    const { data: admin } = await supabase.rpc("is_platform_admin", {
      p_user_id: user.id,
    });
    isPlatformAdmin = Boolean(admin);

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
  }

  return <Dashboard isPlatformAdmin={isPlatformAdmin} />;
}
