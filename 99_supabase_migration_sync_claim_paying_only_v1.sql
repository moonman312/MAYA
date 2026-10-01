-- ============================================================================
-- MAYA: the scheduler claims only properties it may work on, and members no
-- longer write connection rows (audits A27 and A34), v1
-- ============================================================================
--
-- 1. LAPSED SUBSCRIPTIONS (A27). A hotel whose subscription ended keeps its
--    connection Connected, so claim_pms_sync_batch picked it up every tick,
--    first in line (its due time only got older), and the scheduled sync then
--    dropped it at the payment check without handing it back. Its lease ran
--    out ten minutes later and the same thing happened again. With 25 such
--    hotels a 25-hotel batch was half wasted; with 50 or more, paying hotels
--    were never priced, and the number only grows with every cancellation.
--    The claim now leaves alone a connection whose hotel has a subscription
--    row in any status but trialing, active or past_due, which is exactly
--    splitByEntitlement's reading (_shared/billing/entitlement.ts): no row at
--    all is still allowed (the sandbox, a property made by hand, an install
--    with no Stripe keys), and past_due still syncs through Stripe's retries.
--
-- 2. SWITCHED OFF OR NEVER FINISHED (A34). A hotel with is_active = false is
--    checkout's placeholder, a Marketplace property waiting for payment, or a
--    property that was switched off. None of them is synced, priced or sent
--    to; the claim now leaves them alone too. A property that reaches its
--    connection row before its activation (the sign-up connect writes the
--    connection, then activates) waits for the activation.
--
-- 3. DUE AT ONCE WHEN IT CAN BE WORKED ON AGAIN. A subscription that becomes
--    trialing, active or past_due from any other status (or arrives that
--    way), and a hotel switched back on, make the hotel's connections due
--    now, so a restart is synced on the next tick rather than after whatever
--    wait the scheduler last gave it. A connection under a live lease is left
--    to the run that holds it.
--
-- 4. MEMBERS NO LONGER WRITE CONNECTION ROWS (A34). A General Manager could
--    insert or update their own hotel's pms_connections row through the
--    database API: mark a parked connection Connected (synced and sent to
--    without paying), or point base_url at a server of their own (every
--    Cloudbeds or Think call for the hotel, access token included, going
--    there). Every write the app makes to this table runs with the service
--    role (the OAuth callbacks, the Marketplace, the Mews keys, the staff
--    console), and the rest happen in SECURITY DEFINER functions, so the two
--    member write policies are dropped. Members keep reading their own rows
--    (pms_connections_read). The edge functions also refuse a base_url that
--    is not Cloudbeds' or Think's own host, whatever the row says.
--
-- claim_pms_sync_batch is restated from its newest definition
-- (99_supabase_migration_never_paid_retention_v1.sql), with every filter it
-- had kept. Same signature and grants (service role only). The new trigger
-- function is not callable by anyone.
--
-- Run AFTER 99_supabase_migration_never_paid_retention_v1.sql. Idempotent,
-- one transaction. Deploy order: either. The scheduled syncs drop lapsed and
-- switched-off hotels themselves too, and hand them back with an hour's wait
-- rather than leaving them to be claimed again in ten minutes, so the code
-- alone stops the starvation; this file stops them being claimed at all.
--
-- NOT mirrored into 02_supabase_schema.sql yet: fold it in on the next schema
-- consolidation pass.
-- ============================================================================

begin;

-- ── 1 and 2. The claim ───────────────────────────────────────────────────────

create or replace function public.claim_pms_sync_batch(
  p_pms_type text,
  p_limit integer default 25,
  p_lease_seconds integer default 300,
  p_owner text default null
)
returns table (hotel_id uuid, sync_failures integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select c.hotel_id
      from pms_connections c
     where c.pms_type = p_pms_type::pms_type
       and c.status not in ('disconnected', 'pending')
       and c.sync_due_at <= now()
       and (c.sync_lease_until is null or c.sync_lease_until < now())
       -- Live hotels only: not a placeholder, a parked arrival or a
       -- property switched off.
       and exists (
             select 1 from hotels h
              where h.id = c.hotel_id
                and h.is_active
           )
       -- Still owed service, as splitByEntitlement reads it: no
       -- subscription row at all passes.
       and not exists (
             select 1 from hotel_subscriptions s
              where s.hotel_id = c.hotel_id
                and s.status not in ('trialing', 'active', 'past_due')
           )
       and not exists (
             select 1
               from hotels h
              where h.id = c.hotel_id
                and h.data_purged_at is not null
                and not exists (
                      select 1 from import_jobs j
                       where j.hotel_id = h.id
                         and j.status = 'completed'
                         and j.created_at > h.data_purged_at
                    )
           )
     order by c.sync_due_at
     limit p_limit
     for update of c skip locked
  )
  update pms_connections c
     set sync_lease_until = now() + make_interval(secs => p_lease_seconds),
         sync_lease_owner = p_owner
    from due
   where c.hotel_id = due.hotel_id
     and c.pms_type = p_pms_type::pms_type
  returning c.hotel_id, c.sync_failures;
end;
$$;

revoke all on function public.claim_pms_sync_batch(text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.claim_pms_sync_batch(text, integer, integer, text) to service_role;

-- ── 3. Due at once when it can be worked on again ───────────────────────────

create or replace function public.pms_sync_due_on_restart()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hotel uuid;
begin
  if tg_table_name = 'hotel_subscriptions' then
    v_hotel := new.hotel_id;
  else
    v_hotel := new.id;
  end if;
  update pms_connections c
     set sync_due_at = now()
   where c.hotel_id = v_hotel
     and c.sync_due_at > now()
     and (c.sync_lease_until is null or c.sync_lease_until < now());
  return null;
end;
$$;

revoke all on function public.pms_sync_due_on_restart() from public, anon, authenticated;

drop trigger if exists trg_pms_sync_due_on_subscribe on public.hotel_subscriptions;
create trigger trg_pms_sync_due_on_subscribe
  after insert on public.hotel_subscriptions
  for each row
  when (new.status in ('trialing', 'active', 'past_due'))
  execute function public.pms_sync_due_on_restart();

drop trigger if exists trg_pms_sync_due_on_resubscribe on public.hotel_subscriptions;
create trigger trg_pms_sync_due_on_resubscribe
  after update of status on public.hotel_subscriptions
  for each row
  when (new.status in ('trialing', 'active', 'past_due')
        and old.status not in ('trialing', 'active', 'past_due'))
  execute function public.pms_sync_due_on_restart();

drop trigger if exists trg_pms_sync_due_on_activate on public.hotels;
create trigger trg_pms_sync_due_on_activate
  after update of is_active on public.hotels
  for each row
  when (new.is_active and not old.is_active)
  execute function public.pms_sync_due_on_restart();

-- ── 4. Members read their connection rows and write none ────────────────────

alter table public.pms_connections enable row level security;
drop policy if exists pms_connections_access on public.pms_connections;
drop policy if exists pms_connections_insert on public.pms_connections;
drop policy if exists pms_connections_update on public.pms_connections;

commit;

-- ----------------------------------------------------------------------------
-- Checks
-- ----------------------------------------------------------------------------
-- Before or after: the connections the scheduler used to keep claiming for
-- nothing (A27). After this file none of them is claimed.
--
--   select c.pms_type, count(*)
--     from public.pms_connections c
--     join public.hotel_subscriptions s on s.hotel_id = c.hotel_id
--    where c.status not in ('disconnected', 'pending')
--      and s.status not in ('trialing', 'active', 'past_due')
--    group by c.pms_type;
--
-- The policies left on pms_connections: only pms_connections_read.
--
--   select policyname, cmd from pg_policies
--    where schemaname = 'public' and tablename = 'pms_connections';
