import type { HotelRole } from "@/lib/roles";

export type { HotelRole };
export type AppRole = "platform_admin" | "platform_support";
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
  total_rooms_per_type: number;
  external_enterprise_id: string | null;
  created_at: string;
  updated_at: string;
  pms_type: PmsType | null;
  pms_status: PmsConnectionStatus | null;
  pms_last_sync_at: string | null;
  membership_count: number;
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
