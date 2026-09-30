import type { AdminHotelRow } from "./types";

/**
 * A property's plan, rooms, billing status and pricing mode in words, for the
 * Hotels list and each property's page. Words only: no money here, so every
 * staff role may see them.
 */

/** Stripe's subscription statuses, as the Command Center says them. */
const BILLING_STATUS_WORDS: Record<string, string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  unpaid: "Unpaid",
  canceled: "Canceled",
  incomplete: "Incomplete",
  incomplete_expired: "Expired",
  paused: "Paused",
};

type BillingFields = Pick<AdminHotelRow, "billing_status" | "cancel_at_period_end" | "plan_kind" | "billing_interval">;

export function billingStatusWords(row: BillingFields): string {
  if (!row.billing_status) return "No subscription";
  const words = BILLING_STATUS_WORDS[row.billing_status] ?? row.billing_status.replace(/_/g, " ");
  return row.cancel_at_period_end ? `${words}, ends at period end` : words;
}

export function planWords(row: BillingFields): string {
  if (row.plan_kind === "internal") return "Internal";
  if (!row.plan_kind && !row.billing_status) return "No plan";
  if (row.billing_interval === "year") return "Annual";
  if (row.billing_interval === "month") return "Monthly";
  return "Stripe";
}

/** Rooms billed, or the rooms the PMS counts when there is no subscription. Null before the migration. */
export function roomsOf(row: Pick<AdminHotelRow, "billed_rooms" | "measured_rooms">): number | null {
  return row.billed_rooms ?? row.measured_rooms ?? null;
}

/** "Live" or "Simulation"; null when the list did not say (a database before the staff roles migration). */
export function modeWords(row: Pick<AdminHotelRow, "simulation_mode">): "Live" | "Simulation" | null {
  if (row.simulation_mode === undefined || row.simulation_mode === null) return null;
  return row.simulation_mode ? "Simulation" : "Live";
}
