import { requireStaffPage } from "@/lib/admin/staff-page";
import { listPmsSignupGates } from "@/lib/billing/pms-gates";
import { listPmsStatuses } from "@/lib/pms/registry";
import { PmsSignupGateToggle } from "@/components/admin/pms-signup-gate-toggle";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

/**
 * Command Center — which PMS integrations require an access code to sign up.
 *
 * The access code is a single scarcity gate today. This is where that gets
 * opened up per integration once each has proven out with the first beta
 * hotels — Cloudbeds self-serve while Think Reservations stays invite-only,
 * say — without ever becoming a system-wide switch.
 *
 * A platform admin gets the switches (PATCH /api/admin/pms-gates refuses
 * anyone else). A developer reads the same gates under his own session
 * (pms_signup_gates_staff_read) and sees each one in words, with no switch.
 */
export default async function PmsAccessPage() {
  // One check, shared with the layout on a full load (see staff-session.ts).
  const session = await requireStaffPage("pms_access");
  const canChange = session.isPlatformAdmin;

  const gates = await listPmsSignupGates(canChange ? createAdminClient() : createClient(await cookies()));
  const pmsList = listPmsStatuses();
  const gateFor = (pmsType: string) => gates.find((g) => g.pmsType === pmsType)?.requiresSignupCode ?? true;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">PMS Access</h1>
        {canChange ? (
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Turning one of these off lets anyone sign up and connect that PMS with no code — a
            discount or trial code is still honoured either way if they have one. Every integration
            starts gated; nothing changes here until you flip one.
          </p>
        ) : (
          <p className="mt-2 max-w-2xl text-sm text-slate-400">Read only.</p>
        )}
      </div>

      <div className="space-y-3">
        {pmsList.map((pms) =>
          canChange ? (
            <PmsSignupGateToggle
              key={pms.type}
              pmsType={pms.type}
              displayName={pms.displayName}
              requiresSignupCode={gateFor(pms.type)}
            />
          ) : (
            <div
              key={pms.type}
              className="flex items-start justify-between gap-4 rounded border border-slate-800 bg-slate-900 p-4"
            >
              <div className="text-sm font-medium text-slate-100">{pms.displayName}</div>
              <div className="text-xs text-slate-300">{gateFor(pms.type) ? "Code needed" : "Open to anyone"}</div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
