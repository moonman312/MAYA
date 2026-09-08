-- MAYA Test Hotels v1 Migration
-- Analytics counted walkthrough signups as customers. plan_kind already marks
-- internal/sandbox properties, but a Stripe TEST-mode checkout produces a real
-- 'stripe' subscription — indistinguishable from a paying hotel by any column
-- we had. This is that column.
--
-- Deliberately on hotels, not hotel_subscriptions: a property abandoned before
-- checkout has no subscription row and still shouldn't count as a signup.
--
-- Backfills the properties whose names or memberships give them away; anything
-- new gets flagged from the Command Center. Run AFTER
-- 99_supabase_migration_business_metrics_v1.sql. Idempotent.

begin;

alter table hotels
  add column if not exists is_test boolean not null default false;

comment on column hotels.is_test is
  'Excluded from business analytics. Sandbox, e2e fixtures, and walkthrough properties.';

-- Only the unambiguous ones: fixtures and the sandbox, matched by the names
-- the seeds themselves give them. Deliberately NOT matched: "Pending setup%"
-- (checkout's placeholder, which by then carries a real paid subscription) and
-- anything owned by a +suffix address (MHS staff sit on real client properties
-- under those). Both would have flagged paying customers, and a flagged hotel
-- vanishes from revenue with no error — the analytics page has a toggle for
-- the rest, where a human decides.
update hotels set is_test = true
 where is_test = false
   and (name ilike 'MAYA Sandbox%' or name ilike 'MAYA E2E%');

create index if not exists idx_hotels_is_test on hotels (is_test) where is_test;

-- Snapshot rows carry the flag so historical charts stay consistent with the
-- filter — a hotel flagged today shouldn't still inflate last week's line.
alter table hotel_metrics_daily
  add column if not exists is_test boolean not null default false;

update hotel_metrics_daily d set is_test = h.is_test
  from hotels h where h.id = d.hotel_id and d.is_test is distinct from h.is_test;

-- The Command Center's hotel list is an RPC with a fixed return set, so the
-- new column has to be added there too (drop-and-recreate; grants restated).

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
  is_test boolean,
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
      h.is_test,
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
