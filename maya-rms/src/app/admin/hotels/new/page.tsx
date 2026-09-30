import { CreateHotelWizard } from "@/components/admin/create-hotel-wizard";
import { requireStaffPage } from "@/lib/admin/staff-page";
import Link from "next/link";

export const dynamic = "force-dynamic";

/** Creating a hotel: a platform admin's (POST /api/admin/hotels refuses anyone else). */
export default async function AdminNewHotelPage() {
  await requireStaffPage("hotel_create");
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/hotels" className="text-xs text-sky-300 hover:underline">
          ← All hotels
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Onboard a new hotel</h1>
        <p className="text-sm text-slate-400">
          Creates the hotel + settings, stores Mews credentials in Vault, and emails the first
          hotel-admin user an invite.
        </p>
      </div>
      <CreateHotelWizard />
    </div>
  );
}
