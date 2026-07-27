import { Dashboard } from "@/components/dashboard";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function Home() {
  if (isSupabaseConfigured()) {
    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      redirect("/login");
    }

    // No hotel yet and onboarding not explicitly skipped -> onboarding.
    const hotelId = await resolveAccessibleHotelId(supabase);
    if (!hotelId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("onboarding_dismissed_at")
        .eq("id", user.id)
        .maybeSingle();
      if (!profile?.onboarding_dismissed_at) {
        redirect("/onboarding");
      }
    }
  }
  return <Dashboard />;
}
