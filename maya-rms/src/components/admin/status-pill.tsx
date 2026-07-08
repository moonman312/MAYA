import type { PendingInviteStatus, PmsConnectionStatus } from "@/lib/admin/types";

const PMS_STYLES: Record<PmsConnectionStatus, string> = {
  connected: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  pending: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  degraded: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  disconnected: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  error: "bg-rose-500/10 text-rose-300 border-rose-500/30",
};

const INVITE_STYLES: Record<PendingInviteStatus, string> = {
  pending: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  accepted: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  expired: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  revoked: "bg-rose-500/10 text-rose-300 border-rose-500/30",
};

export function PmsStatusPill({ status }: { status: PmsConnectionStatus | null }) {
  if (!status) {
    return <span className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-500">no PMS</span>;
  }
  return (
    <span className={`rounded border px-2 py-0.5 text-xs font-medium capitalize ${PMS_STYLES[status]}`}>
      {status}
    </span>
  );
}

export function InviteStatusPill({ status }: { status: PendingInviteStatus }) {
  return (
    <span className={`rounded border px-2 py-0.5 text-xs font-medium capitalize ${INVITE_STYLES[status]}`}>
      {status}
    </span>
  );
}
