-- Hotels hardening: lifecycle and triage columns stop being writable from the
-- browser.
--
-- hotels_update is row-scoped (can_manage_hotel) but says nothing about
-- columns, and Supabase's default grants give `authenticated` UPDATE on the
-- whole table. Together that lets a hotel_admin PATCH /rest/v1/hotels and
-- write columns that belong to the platform, not the property:
--
--   * is_active / setup_pending_at — checkout creates the hotel row inactive
--     and pending (billing v2); the PMS connect callback flips both once a
--     connection actually exists. A buyer who abandons the card form already
--     holds hotel_admin on the pending row and could flip it live themselves,
--     with no subscription attached.
--   * signup_abandoned_at / _by / _note — platform triage state (stalled
--     signups v1). A stalled signup could quietly remove itself from the
--     follow-up list, or write the note field as if support had.
--
-- Two layers, because grants and triggers fail differently.
--
-- Run AFTER 99_supabase_migration_stalled_signups_v1.sql. Idempotent.

/* ── 1. UPDATE re-granted per column ──────────────────────────────────────── */
--
-- The only user-scoped hotel write in the app is the onboarding rename
-- (onboarding/answers, `name` only); timezone and currency are the other
-- fields an owner plausibly maintains by hand. Everything else on the row is
-- written by service-role paths — checkout, connect adoption, the import
-- worker, Command Center — which keep their table-wide grant.

revoke update on public.hotels from public, anon, authenticated;
grant update (name, timezone, currency) on public.hotels to authenticated;
grant update on public.hotels to service_role;

/* ── 2. is_active / setup_pending_at pinned in a trigger ──────────────────── */
--
-- The column grant above already blocks these two, but a later
-- `grant all on all tables` would silently reopen it. The trigger doesn't
-- care: unless the writer is service_role (or a direct psql session — seeds
-- and manual fixes run as postgres), both columns keep their old values.
-- Pinned rather than raised so a PATCH that includes them still applies its
-- legitimate columns. No platform-admin exemption: Command Center edits go
-- through the service-role client already.

create or replace function public.hotels_pin_lifecycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  new.is_active := old.is_active;
  new.setup_pending_at := old.setup_pending_at;
  return new;
end;
$$;

drop trigger if exists trg_hotels_pin_lifecycle on public.hotels;
create trigger trg_hotels_pin_lifecycle
  before update on public.hotels
  for each row
  execute function public.hotels_pin_lifecycle();
