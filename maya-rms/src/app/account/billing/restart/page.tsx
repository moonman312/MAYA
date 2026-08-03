import { SubscribeStep } from "@/components/onboarding/subscribe-step";
import { loadAccountBilling } from "@/lib/billing/account";
import { pmsSignupCodeRequired } from "@/lib/billing/pms-gates";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { getRegistry, type PmsType } from "@/lib/pms/registry";
import { hasHotelRank } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Where a cancelled property comes back in — the same checkout as a first
 * signup, minus the questions we already know the answers to.
 *
 * A cancelled subscription is gone in Stripe; restarting means a new one, so
 * this drives POST /api/billing/checkout like the onboarding screen does. The
 * property's PMS is declared from its existing connection rather than asked,
 * which also means the code field follows that PMS's own gate: a fresh code
 * while it's gated (the old one is spent — one redemption per property), none
 * once it's open.
 */
export default async function RestartPage() {
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) redirect("/onboarding");
  if (!(await hasHotelRank(supabase, hotelId, "general_manager"))) redirect("/account/billing");

  // Only a dead subscription belongs here. A live one manages itself from the
  // billing page, and no row at all means a hand-made property with nothing to
  // restart — both go back to the page that explains them.
  const billing = await loadAccountBilling(supabase, hotelId);
  if (!billing || billing.entitled) redirect("/account/billing");

  const { data: conn } = await supabase
    .from("pms_connections")
    .select("pms_type, status")
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: true });
  const pmsType = (conn?.find((c) => c.status === "connected") ?? conn?.[0])?.pms_type as
    | PmsType
    | undefined;

  // No connection means we can't vouch for their PMS, and an unreadable gate
  // must not swing signup open — both directions land on "code required".
  const requiresCode =
    !pmsType || !isAdminConfigured()
      ? true
      : await pmsSignupCodeRequired(createAdminClient(), pmsType);

  return (
    <main className="mx-auto max-w-2xl px-6 pb-16">
      <SubscribeStep
        title="Restart your subscription"
        intro="Same pricing as always — per room, per month. Confirm the size and period and you're back; pricing picks up as soon as checkout completes."
        footnote="Card details are handled by Stripe — they never touch MAYA. Your PMS connection is still in place, so there's nothing to set up again."
        initialRooms={billing.rooms || undefined}
        initialInterval={billing.interval}
        lockPms={Boolean(pmsType)}
        pmsOptions={
          pmsType
            ? [
                {
                  type: pmsType,
                  displayName: getRegistry(pmsType)?.displayName ?? pmsType,
                  requiresSignupCode: requiresCode,
                },
              ]
            : []
        }
      />
    </main>
  );
}
