import { GodModeButton } from "@/components/admin/god-mode-button";
import { BusinessNumbersFrame, HotelBusinessNumbers } from "@/components/admin/hotel-business-numbers";
import { HotelMembershipsCard } from "@/components/admin/hotel-memberships-card";
import { OpenPropertyButton } from "@/components/admin/open-property-button";
import { HotelPmsCard } from "@/components/admin/hotel-pms-card";
import { ReadOnlyMembersCard, ReadOnlyPmsCard, ReadOnlyPricingMode } from "@/components/admin/hotel-read-only";
import { HotelTestToggle } from "@/components/admin/hotel-test-toggle";
import { SimulationModeToggle } from "@/components/admin/simulation-mode-toggle";
import { PmsStatusPill } from "@/components/admin/status-pill";
import { businessWindow } from "@/lib/admin/business-window";
import { billingStatusWords, planWords, roomsOf } from "@/lib/admin/hotel-words";
import { getHotel, getHotelSimulationMode } from "@/lib/admin/hotels";
import { listHotelMemberships, listPendingInvites } from "@/lib/admin/memberships";
import { requireStaffPage } from "@/lib/admin/staff-page";
import { staffCanSee } from "@/lib/admin/staff-session";
import type { AdminHotelUserRow, AdminPendingInviteRow } from "@/lib/admin/types";
import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { pricingHorizonDays } from "@/lib/pms/pricing-window";
import { listPmsStatuses } from "@/lib/pms/registry";
import { hotelToday } from "@/lib/simulator";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

/**
 * One property, for every staff role. A platform admin gets the controls:
 * open the property, God Mode, pricing mode, the test flag, the PMS
 * connection and the team (changes need God Mode). A developer or sales login
 * gets the same facts with no control at all (ReadOnly* cards), and each
 * route behind the admin's controls refuses them. The team list is for a role
 * with hotel_team (admin, developer), pending invites for an admin only, and
 * occupancy, ADR and revenue for a role with business_numbers (admin, and
 * sales on a real property).
 */
export default async function AdminHotelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<{ nights?: string }>;
}) {
  const session = await requireStaffPage("hotels");
  const { hotelId } = await params;
  const { nights } = await searchParams;
  const isAdmin = session.isPlatformAdmin;
  const canTeam = staffCanSee(session, "hotel_team");
  const canInvites = staffCanSee(session, "pending_invites");
  const canMoney = staffCanSee(session, "business_numbers");
  const ssr = createClient(await cookies());
  // Only an admin's page reads with the service role (the settings the
  // controls need); staff read the same facts off the hotel list's row.
  const admin = isAdmin && isAdminConfigured() ? createAdminClient() : null;
  // Reads that don't need each other, so one wait. A role never asks for what
  // it may not read: the function would refuse, not answer empty.
  const [hotel, memberships, pendingInvites, adminSimulationMode, windowDays] = await Promise.all([
    getHotel(ssr, hotelId),
    canTeam ? listHotelMemberships(ssr, hotelId) : Promise.resolve([] as AdminHotelUserRow[]),
    canInvites ? listPendingInvites(ssr, hotelId) : Promise.resolve([] as AdminPendingInviteRow[]),
    // Pricing mode lives in hotel_settings; read with the service-role client
    // so RLS never hides it from the admin view. Defaults to simulation.
    admin ? getHotelSimulationMode(admin, hotelId) : Promise.resolve(null),
    // The window the hotel's last daily pass used (the syncs' switch sets it).
    admin ? hotelPricingHorizon(admin, hotelId) : Promise.resolve(pricingHorizonDays()),
  ]);
  if (!hotel) {
    notFound();
  }
  const simulationMode = adminSimulationMode ?? hotel.simulation_mode ?? true;
  const rooms = roomsOf(hotel);
  const range = businessWindow(nights, hotelToday(hotel.timezone));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/admin/hotels" className="text-xs text-sky-300 hover:underline">
            ← All hotels
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{hotel.name}</h1>
          <p className="text-sm text-slate-400">
            {hotel.timezone} · {hotel.currency} · {hotel.total_rooms_per_type} rooms/type
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                simulationMode
                  ? "bg-slate-700 text-slate-200"
                  : "bg-emerald-500/20 text-emerald-300"
              }`}
            >
              {simulationMode ? "Simulation" : "Live"}
            </span>
            <PmsStatusPill status={hotel.pms_status} />
          </div>
          {/* Viewing is always yours; changing anything on this page or on the property's dashboard needs God Mode. */}
          {isAdmin ? (
            <div className="flex items-center gap-2">
              <OpenPropertyButton hotelId={hotel.id} />
              <GodModeButton />
            </div>
          ) : (
            <span className="text-xs text-slate-500">Read only</span>
          )}
        </div>
      </div>

      <section className="rounded border border-slate-800 bg-slate-900">
        <header className="border-b border-slate-800 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Overview</h2>
        </header>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Timezone</dt>
            <dd className="text-slate-200">{hotel.timezone}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Currency</dt>
            <dd className="text-slate-200">{hotel.currency}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Rooms per type</dt>
            <dd className="text-slate-200">{hotel.total_rooms_per_type}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Active</dt>
            <dd className="text-slate-200">{hotel.is_active ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Plan</dt>
            <dd className="text-slate-200">{planWords(hotel)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Billing</dt>
            <dd className="text-slate-200">
              {billingStatusWords(hotel)}
              {hotel.billing_status === "trialing" && hotel.trial_end
                ? `, until ${new Date(hotel.trial_end).toLocaleDateString()}`
                : ""}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Rooms</dt>
            <dd className="text-slate-200">{rooms ?? "n/a"}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs uppercase tracking-wide text-slate-500">Mews enterprise ID</dt>
            <dd className="break-all text-slate-200">{hotel.external_enterprise_id ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Created</dt>
            <dd className="text-slate-200">{new Date(hotel.created_at).toLocaleDateString()}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Last sync</dt>
            <dd className="text-slate-200">
              {hotel.pms_last_sync_at
                ? new Date(hotel.pms_last_sync_at).toLocaleString()
                : "never"}
            </dd>
          </div>
        </dl>
      </section>

      {canMoney ? (
        <BusinessNumbersFrame hotelId={hotel.id} range={range}>
          {hotel.is_test && !isAdmin ? (
            <p className="text-sm text-slate-400">Business numbers are shown for real properties only.</p>
          ) : (
            <Suspense key={range.key} fallback={<p className="text-sm text-slate-500">Adding up the nights...</p>}>
              <HotelBusinessNumbers hotelId={hotel.id} currency={hotel.currency} range={range} />
            </Suspense>
          )}
        </BusinessNumbersFrame>
      ) : null}

      {isAdmin ? (
        <>
          <section className="rounded border border-slate-800 bg-slate-900">
            <header className="border-b border-slate-800 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                Pricing mode
              </h2>
            </header>
            <div className="space-y-4 p-4">
              <SimulationModeToggle
                hotelId={hotel.id}
                simulationMode={simulationMode}
                pmsType={hotel.pms_type}
                pmsStatus={hotel.pms_status}
                windowDays={windowDays}
              />
              <HotelTestToggle hotelId={hotel.id} isTest={hotel.is_test === true} />
            </div>
          </section>

          <HotelPmsCard
            hotelId={hotel.id}
            pmsType={hotel.pms_type}
            pmsStatus={hotel.pms_status}
            pmsStatuses={listPmsStatuses()}
          />

          <HotelMembershipsCard
            hotelId={hotel.id}
            memberships={memberships}
            pendingInvites={pendingInvites.filter((p) => p.status === "pending")}
          />
        </>
      ) : (
        <>
          <ReadOnlyPricingMode simulationMode={simulationMode} isTest={hotel.is_test === true} />
          <ReadOnlyPmsCard pmsType={hotel.pms_type} pmsStatus={hotel.pms_status} lastSyncAt={hotel.pms_last_sync_at} />
          {canTeam ? <ReadOnlyMembersCard memberships={memberships} /> : null}
        </>
      )}
    </div>
  );
}
