import type { HotelRole } from "@/lib/roles";

export type { HotelRole };
export type AppRole = "platform_admin" | "platform_support" | "developer" | "sales";
export type MembershipStatus = "invited" | "active" | "suspended" | "revoked";
export type PendingInviteStatus = "pending" | "accepted" | "expired" | "revoked";
export type PmsType = "mews" | "cloudbeds" | "think" | "opera" | "other";
export type PmsConnectionStatus =
  | "pending"
  | "connected"
  | "degraded"
  | "disconnected"
  | "error";

export type AdminHotelRow = {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  is_active: boolean;
  /** Set on checkout's placeholder rows until a PMS connect adopts them. */
  setup_pending_at: string | null;
  /** Sandbox, fixture, or walkthrough — left out of business analytics. */
  is_test: boolean;
  total_rooms_per_type: number;
  external_enterprise_id: string | null;
  created_at: string;
  updated_at: string;
  pms_type: PmsType | null;
  pms_status: PmsConnectionStatus | null;
  pms_last_sync_at: string | null;
  membership_count: number;
  /**
   * From 99_supabase_migration_staff_roles_v1.sql on (undefined before it):
   * pricing mode, the window the last daily pass used, and the plan and
   * billing status in words.
   */
  simulation_mode?: boolean;
  pricing_horizon_days?: number | null;
  billing_status?: string | null;
  plan_kind?: "stripe" | "internal" | null;
  billing_interval?: "month" | "year" | null;
  billed_rooms?: number | null;
  trial_end?: string | null;
  cancel_at_period_end?: boolean | null;
  measured_rooms?: number;
  /**
   * The newest hotel_metrics_daily MRR. Null unless the caller may read
   * business numbers (a platform admin, or sales on a real property).
   */
  list_mrr_cents?: number | null;
  net_mrr_cents?: number | null;
  mrr_day?: string | null;
};

export type AdminHotelUserRow = {
  membership_id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  role: HotelRole;
  status: MembershipStatus;
  created_at: string;
};

export type AdminPlatformUserRow = {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  platform_roles: string[] | null;
  hotel_count: number;
};

export type AdminPendingInviteRow = {
  id: string;
  email: string;
  hotel_id: string;
  hotel_name: string;
  role: HotelRole;
  status: PendingInviteStatus;
  invited_by: string | null;
  invited_by_email: string | null;
  invited_at: string;
  accepted_at: string | null;
};
