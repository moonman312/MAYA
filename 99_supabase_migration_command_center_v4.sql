-- MAYA Command Center v4 Migration — expose setup_pending_at on the hotel list
-- ============================================================================
-- platform_list_hotels returned every hotels row with nothing marking the
-- placeholders checkout creates (99_supabase_migration_billing_v2_pending_hotel):
-- an abandoned card form looked identical to a paying property, so the admin
-- overview counted it as a hotel and against the PMS-connected rate.
--
-- Adds setup_pending_at to the return set so callers can tell "never finished
-- starting" from a real property. Deliberately no filtering here — the hotels
-- list should keep showing placeholders; what to hide is each screen's call.
--
-- Return-type changes need drop-and-recreate, so grants are restated below.
-- Until this runs, the app sees no setup_pending_at column and counts every
-- row, exactly as before.
--
-- Run AFTER 99_supabase_migration_billing_v2_pending_hotel.sql (the column)
-- and the command_center v1–v3 files. Idempotent.

begin;

drop function if exists public.platform_list_hotels(text);

create function public.platform_list_hotels(
  p_search text default null
) returns table (
  id uuid,
  name text,
  timezone text,
  currency text,
  is_active boolean,
  setup_pending_at timestamptz,
  total_rooms_per_type int,
  external_enterprise_id text,
  created_at timestamptz,
  updated_at timestamptz,
  pms_type public.pms_type,
  pms_status public.connection_status,
  pms_last_sync_at timestamptz,
  membership_count int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      h.id,
      h.name,
      h.timezone,
      h.currency,
      h.is_active,
      h.setup_pending_at,
      h.total_rooms_per_type,
      h.external_enterprise_id,
      h.created_at,
      h.updated_at,
      pc.pms_type,
      pc.status,
      pc.last_sync_at,
      (select count(*)::int from public.hotel_memberships hm where hm.hotel_id = h.id) as membership_count
    from public.hotels h
    left join public.pms_connections pc on pc.hotel_id = h.id
    where p_search is null
       or h.name ilike '%' || p_search || '%'
    order by h.created_at desc;
end;
$$;

revoke all on function public.platform_list_hotels(text) from public;
grant execute on function public.platform_list_hotels(text)
  to authenticated, service_role;

commit;
