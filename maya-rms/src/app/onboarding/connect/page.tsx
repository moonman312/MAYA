import { listPmsStatuses } from "@/lib/pms/registry";
import { ConnectPms } from "@/components/onboarding/connect-pms";

export default function ConnectPage() {
  const statuses = listPmsStatuses();
  return <ConnectPms pmsOptions={statuses} />;
}
