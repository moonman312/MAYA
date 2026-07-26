import { HotelMembershipsCard } from "@/components/admin/hotel-memberships-card";
import { HotelPmsCard } from "@/components/admin/hotel-pms-card";
import { SimulationModeToggle } from "@/components/admin/simulation-mode-toggle";
import { PmsStatusPill } from "@/components/admin/status-pill";
import { getHotel, getHotelSimulationMode } from "@/lib/admin/hotels";
import { listHotelMemberships, listPendingInvites } from "@/lib/admin/memberships";
import { listPmsStatuses } from "@/lib/pms/registry";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminHotelDetailPage({
  params,
}: {
  params: Promise<{ hotelId: string }>;
}) {
  const { hotelId } = await params;
  const ssr = createClient(await cookies());
  const [hotel, memberships, pendingInvites] = await Promise.all([
    getHotel(ssr, hotelId),
    listHotelMemberships(ssr, hotelId),
    listPendingInvites(ssr, hotelId),
  ]);
  const pmsStatuses = listPmsStatuses();
  // Pricing mode lives in hotel_settings; read with the service-role client so
  // RLS never hides it from the admin view. Defaults to simulation.
  const simulationMode = isAdminConfigured()
    ? await getHotelSimulationMode(createAdminClient(), hotelId)
    : true;
  if (!hotel) {
    notFound();
  }

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

      <section className="rounded border border-slate-800 bg-slate-900">
        <header className="border-b border-slate-800 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Pricing mode
          </h2>
        </header>
        <div className="p-4">
          <SimulationModeToggle hotelId={hotel.id} simulationMode={simulationMode} />
        </div>
      </section>

      <HotelPmsCard
        hotelId={hotel.id}
        pmsType={hotel.pms_type}
        pmsStatus={hotel.pms_status}
        pmsStatuses={pmsStatuses}
      />

      <HotelMembershipsCard
        hotelId={hotel.id}
        memberships={memberships}
        pendingInvites={pendingInvites.filter((p) => p.status === "pending")}
      />
    </div>
  );
}
