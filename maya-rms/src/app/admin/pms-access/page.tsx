import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { listPmsSignupGates } from "@/lib/billing/pms-gates";
import { listPmsStatuses } from "@/lib/pms/registry";
import { PmsSignupGateToggle } from "@/components/admin/pms-signup-gate-toggle";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Command Center — which PMS integrations require an access code to sign up.
 *
 * The access code is a single scarcity gate today. This is where that gets
 * opened up per integration once each has proven out with the first beta
 * hotels — Cloudbeds self-serve while Think Reservations stays invite-only,
 * say — without ever becoming a system-wide switch.
 */
export default async function PmsAccessPage() {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) redirect("/login");

  const gates = await listPmsSignupGates(ctx.admin);
  const pmsList = listPmsStatuses();
  const gateFor = (pmsType: string) => gates.find((g) => g.pmsType === pmsType)?.requiresSignupCode ?? true;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">PMS Access</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-400">
          Turning one of these off lets anyone sign up and connect that PMS with no code — a
          discount or trial code is still honoured either way if they have one. Every integration
          starts gated; nothing changes here until you flip one.
        </p>
      </div>

      <div className="space-y-3">
        {pmsList.map((pms) => (
          <PmsSignupGateToggle
            key={pms.type}
            pmsType={pms.type}
            displayName={pms.displayName}
            requiresSignupCode={gateFor(pms.type)}
          />
        ))}
      </div>
    </div>
  );
}
