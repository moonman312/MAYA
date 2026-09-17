import { PathChoice } from "@/components/onboarding/path-choice";
import { PmsReconnect } from "@/components/pms-reconnect";
import { SubscribeStep, type SubscribePmsOption } from "@/components/onboarding/subscribe-step";
import { listUnpaidMarketplaceHotels } from "@/lib/billing/pending-hotel";
import { listPmsSignupGates } from "@/lib/billing/pms-gates";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { pendingBillingOffer, resolveOnboardingStep } from "@/lib/onboarding/step";
import { queuePrePaymentImport } from "@/lib/pms/eager-import";
import { marketplaceTrialDays } from "@/lib/pms/marketplace-activate";
import { marketplaceReconnectNeeded } from "@/lib/pms/purged";
import { getRegistry, listPmsStatuses, type PmsType } from "@/lib/pms/registry";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * The front door of onboarding, which is payment now. Whichever step the user is
 * actually on gets rendered here rather than living behind its own URL, so there
 * is one place to come back to — from a cancelled checkout, a closed tab, the
 * dashboard — and it always lands on the right thing.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const cancelled = (await searchParams).checkout === "cancelled";

  // No Supabase means no user and no billing, so there is nothing to resolve —
  // the demo build keeps the path choice it has always shown.
  if (!isSupabaseConfigured()) return <PathChoice />;

  const supabase = createClient(await cookies());
  const step = await resolveOnboardingStep(supabase);
  if (step === "connect") redirect("/onboarding/connect");
  if (step === "done") redirect("/");
  if (step === "choose") return <PathChoice />;

  // A subscription can already exist here: one whose payment is failing, or a
  // Marketplace property still waiting on activation. On a Marketplace arrival
  // the property on screen is the one the link should manage, when it has one.
  const marketplace = await marketplaceArrival(supabase);
  const manageBilling = await pendingBillingOffer(supabase, marketplace?.hotelId);
  if (marketplace) {
    const days = marketplace.trialDays;
    const name = marketplace.propertyName ?? "Your property";
    const progress = marketplace.progress;
    const reconnect = marketplace.reconnect;
    const subscribe = (
      <SubscribeStep
        cancelled={cancelled}
        lockPms
        hotelId={marketplace.hotelId}
        progress={progress}
        deferrable={marketplace.deferrable}
        manageBilling={manageBilling}
        pmsOptions={[
          { type: marketplace.pmsType, displayName: marketplace.displayName, requiresSignupCode: false },
        ]}
        title={reconnect ? name : `${name} is connected`}
        intro={
          days > 0
            ? `Try MAYA free for ${days} days. Nothing is charged until the trial ends, and you can cancel any time.`
            : "Set up a payment method to start using MAYA."
        }
        baseTrialDays={days}
        submitLabel={days > 0 ? "Set up payment" : "Continue to payment"}
        footnote="Card details are handled by Stripe. They never touch MAYA."
      />
    );
    if (!reconnect) return subscribe;
    // The connection is gone (the retention sweep removed a never-paid
    // property's data), so the owner gets the ordinary reconnect prompt above
    // the same screen. Reconnecting reads the history again.
    return (
      <>
        <div className="pt-10">
          <PmsReconnect
            hotelId={marketplace.hotelId}
            pmsType={marketplace.pmsType}
            status="disconnected"
            authKind={reconnect.authKind}
            displayName={marketplace.displayName}
            canManage
            placement="banner"
            historyRemoved={reconnect.historyRemoved}
          />
        </div>
        {subscribe}
      </>
    );
  }
  return (
    <SubscribeStep
      cancelled={cancelled}
      pmsOptions={await subscribePmsOptions()}
      manageBilling={manageBilling}
    />
  );
}

/**
 * A property that arrived from the Cloudbeds Marketplace is connected and owned
 * but not paid for. It gets the same subscribe screen with the PMS settled, no
 * code asked for, and the Marketplace trial shown. It is also where a bounced
 * checkout lands back, so setting up payment is always one click away.
 *
 * A group grant parks several; the oldest unpaid one is next, and the screen
 * says where in the group it sits so paying three times in a row does not feel
 * like the same screen refusing to go away. One the owner has said "not now" to
 * is out of the queue (listUnpaidMarketplaceHotels leaves it out) but still in
 * the group's total, so it counts as done-for-now: "Property 2 of 3" after
 * skipping the first, not a jump to "1 of 2".
 */
async function marketplaceArrival(supabase: SupabaseClient): Promise<{
  hotelId: string;
  pmsType: string;
  displayName: string;
  propertyName: string | null;
  trialDays: number;
  progress?: { index: number; total: number };
  /** Whether "Not now" is offered: there has to be somewhere else to go. */
  deferrable: boolean;
  /** Set when the property has no PMS connection left and has to be reconnected first. */
  reconnect: { authKind: string; historyRemoved: boolean } | null;
} | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return null;
    const admin = createAdminClient();
    const unpaid = await listUnpaidMarketplaceHotels(admin, userId);
    const next = unpaid[0];
    if (!next) return null;

    // Read before queueing: with no connection there is nothing to import yet.
    const needed = await marketplaceReconnectNeeded(admin, next.hotelId).catch((e: unknown) => {
      console.error(
        JSON.stringify({
          fn: "marketplaceArrival",
          step: "reconnect_needed",
          hotelId: next.hotelId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return null;
    });

    // The property on this screen is the one whose history gets read, now:
    // a group sibling as it comes up, never one put off with "Not now".
    await queuePrePaymentImport(admin, next.hotelId, userId).catch((e: unknown) => {
      console.error(
        JSON.stringify({
          fn: "marketplaceArrival",
          step: "queue_import",
          hotelId: next.hotelId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    });

    let progress: { index: number; total: number } | undefined;
    if (next.groupKey) {
      // Everyone in the group the owner has claimed, paid or not; the unpaid
      // ones from the same group are what is left, so "index" is what is done
      // plus this one.
      const { count } = await admin
        .from("pms_marketplace_claims")
        .select("hotel_id", { count: "exact", head: true })
        .eq("group_key", next.groupKey)
        .eq("claimed_by", userId)
        .not("claimed_at", "is", null);
      const total = count ?? 0;
      // Deferred siblings are not in `unpaid`, so they land on the done side.
      const left = unpaid.filter((u) => u.groupKey === next.groupKey).length;
      if (total > 1) progress = { index: total - left + 1, total };
    }

    // "Not now" on the LAST parked property with nothing live would strand
    // the owner on the ordinary subscribe screen with nothing to set up, so it
    // is only offered while another sibling is waiting or a property is live.
    const deferrable = unpaid.length > 1 || (await resolveAccessibleHotelId(supabase)) != null;

    const pms = listPmsStatuses().find((p) => p.type === next.pmsType);
    const registry = needed ? getRegistry(next.pmsType as PmsType) : null;
    return {
      hotelId: next.hotelId,
      pmsType: next.pmsType,
      displayName: pms?.displayName ?? next.pmsType,
      propertyName: next.propertyName ?? next.name ?? null,
      trialDays: marketplaceTrialDays(),
      progress,
      deferrable,
      reconnect:
        needed && registry ? { authKind: registry.authKind, historyRemoved: needed.historyRemoved } : null,
    };
  } catch (e) {
    // Falls back to the ordinary screen: they can still pay, they just get
    // asked which PMS they use and for a code they do not have.
    console.error(
      JSON.stringify({ fn: "marketplaceArrival", error: e instanceof Error ? e.message : String(e) }),
    );
    return null;
  }
}

/**
 * Which PMS answer decides whether the code field is optional, so it carries
 * each gate's state (/admin/pms-access). "Something else" is always gated: an
 * unknown system can't have had its gate opened.
 */
async function subscribePmsOptions(): Promise<SubscribePmsOption[]> {
  let gates: Awaited<ReturnType<typeof listPmsSignupGates>> = [];
  try {
    gates = await listPmsSignupGates(createAdminClient());
  } catch (e) {
    // Same failure direction as pmsSignupCodeRequired: an unreadable gate
    // means the code stays required, never that signup swings open.
    console.error(
      JSON.stringify({
        fn: "subscribePmsOptions",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
  const requiredFor = (type: string) =>
    gates.find((g) => g.pmsType === type)?.requiresSignupCode ?? true;
  return [
    ...listPmsStatuses().map((pms) => ({
      type: pms.type as string,
      displayName: pms.displayName,
      requiresSignupCode: requiredFor(pms.type),
    })),
    { type: "other", displayName: "Something else", requiresSignupCode: true },
  ];
}
