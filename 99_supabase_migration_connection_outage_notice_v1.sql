-- ============================================================================
-- MAYA connection outage email (G57) and Mews keys that stop working (G54), v1
-- ============================================================================
--
-- Decided by Jake on 2026-09-27 (G57, option A): once a property's PMS
-- connection has been down about an hour (Disconnected or Error, never
-- Degraded), its General Manager and Hotel Admin get one email, and the same
-- notice goes to our Slack alert channel. One email per outage: a new outage
-- after the connection comes back may email again.
--
-- G54: a Mews connection whose keys stopped working kept reading Connected,
-- because nothing on Mews' side ever tells MAYA and the sync only ever wrote
-- 'connected'. The Mews sync now counts reads refused as bad keys, and after
-- three in a row the connection reads Error (so the banner and the G57 email
-- follow). A good read puts it back.
--
-- Everything lives on pms_connections:
--
--   * down_since: when the current outage began. Set and cleared by the
--     trigger below on every status change, whoever writes it (the syncs, the
--     Cloudbeds uninstall webhook, a refresh the vendor refuses, support), so
--     nothing that marks a connection down has to remember to stamp it.
--     Moving between Disconnected and Error is the same outage.
--   * outage_notice_at: when the current outage's notice was dealt with
--     (emailed, or deliberately not, for a property that no longer pays).
--     Null while one is still owed. The trigger clears it when the connection
--     comes back. A writer that takes a connection down on purpose (support
--     removing Mews keys at the owner's request) sets it in the same update,
--     and the trigger keeps it: nobody is emailed about a disconnect they
--     asked for.
--   * auth_failures: reads in a row the PMS refused as bad credentials. Only
--     the Mews sync counts them today. The trigger sets it back to 0 whenever
--     last_sync_at moves, which only a good read does.
--   * pms_note_auth_failure(): counts one refusal and, at the threshold,
--     marks a Connected or Degraded connection Error, in one statement.
--
-- The scheduled sync functions look for outages owed a notice once per
-- invocation: one query on the partial index below, which is empty nearly
-- all the time.
--
-- Access: pms_connections keeps its row level security and policies; this
-- file adds no policy and changes no grant on the table. The new function is
-- service role only. The trigger function runs as the writer and only
-- touches the row being written.
--
-- Backfill: connections already Disconnected or Error when this runs get
-- down_since = updated_at (the best record of when they went down) and
-- outage_notice_at = now(), so running this does not email every property
-- that has been down for weeks. Section 5 has the statement that emails
-- them anyway.
--
-- Safe to run more than once. Run BEFORE deploying the edge functions and the
-- app that go with it: the admin "remove Mews keys" route writes
-- outage_notice_at, and the scheduled syncs read these columns.
--
-- Sections:
--   1. Columns and index
--   2. Trigger: down_since, outage_notice_at, auth_failures
--   3. pms_note_auth_failure()
--   4. Backfill of connections already down
--   5. Checks
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Columns and index
-- ----------------------------------------------------------------------------

alter table public.pms_connections
  add column if not exists down_since timestamptz,
  add column if not exists outage_notice_at timestamptz,
  add column if not exists auth_failures integer not null default 0;

comment on column public.pms_connections.down_since is
  'When the current outage began: the status last moved into disconnected or error. Null while the connection is not down. Kept by trg_pms_connections_track_outage.';
comment on column public.pms_connections.outage_notice_at is
  'When the current outage''s email to the General Manager and Hotel Admin was sent, or decided against. Null while one is still owed. Cleared when the connection comes back.';
comment on column public.pms_connections.auth_failures is
  'Reads in a row the PMS refused as bad credentials (counted by the Mews sync). Back to 0 on any good read (last_sync_at moves).';

create index if not exists idx_pms_connections_outage_due
  on public.pms_connections (pms_type, down_since)
  where down_since is not null and outage_notice_at is null;

-- ----------------------------------------------------------------------------
-- 2. Trigger
-- ----------------------------------------------------------------------------

create or replace function public.pms_connections_track_outage()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  is_down boolean := new.status::text in ('disconnected', 'error');
  was_down boolean := false;
begin
  if tg_op = 'UPDATE' then
    was_down := old.status::text in ('disconnected', 'error');
  end if;

  if is_down and not was_down then
    -- A new outage. outage_notice_at is left as the writer sent it: null
    -- unless they are marking a deliberate disconnect as already handled.
    new.down_since := now();
  elsif not is_down then
    new.down_since := null;
    new.outage_notice_at := null;
  end if;
  -- Down to down (Disconnected to Error or back) is the same outage.

  if tg_op = 'UPDATE'
     and new.last_sync_at is not null
     and new.last_sync_at is distinct from old.last_sync_at then
    new.auth_failures := 0;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_pms_connections_track_outage on public.pms_connections;
create trigger trg_pms_connections_track_outage
  before insert or update of status, last_sync_at on public.pms_connections
  for each row execute function public.pms_connections_track_outage();

-- ----------------------------------------------------------------------------
-- 3. pms_note_auth_failure()
-- ----------------------------------------------------------------------------
-- One refused read. Returns the new count and status, or no row when the
-- connection is not in service (pending waits on payment, disconnected has
-- nothing left to refuse). Only Connected and Degraded are moved to Error;
-- a connection already in Error keeps counting.

create or replace function public.pms_note_auth_failure(
  p_hotel_id uuid,
  p_pms_type text,
  p_threshold integer default 3
)
returns table (failures integer, new_status text)
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.pms_connections c
     set auth_failures = c.auth_failures + 1,
         status = case
           when c.auth_failures + 1 >= greatest(coalesce(p_threshold, 3), 1)
            and c.status::text in ('connected', 'degraded')
           then 'error'::connection_status
           else c.status
         end,
         updated_at = now()
   where c.hotel_id = p_hotel_id
     and c.pms_type = p_pms_type::pms_type
     and c.status::text in ('connected', 'degraded', 'error')
  returning c.auth_failures, c.status::text
$$;

revoke all on function public.pms_note_auth_failure(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.pms_note_auth_failure(uuid, text, integer) to service_role;

-- ----------------------------------------------------------------------------
-- 4. Backfill of connections already down
-- ----------------------------------------------------------------------------
-- Only rows that have never been stamped, so a second run changes nothing.
-- Status is not in the SET list, so the trigger does not fire.

update public.pms_connections
   set down_since = coalesce(updated_at, now()),
       outage_notice_at = now()
 where status::text in ('disconnected', 'error')
   and down_since is null;

commit;

-- ----------------------------------------------------------------------------
-- 5. Checks
-- ----------------------------------------------------------------------------
-- Connections down right now, and whether a notice is still owed:
--
--   select c.hotel_id, h.name, c.pms_type, c.status, c.down_since,
--          c.outage_notice_at, c.auth_failures
--     from public.pms_connections c
--     join public.hotels h on h.id = c.hotel_id
--    where c.down_since is not null
--    order by c.down_since;
--
-- To email the properties that were already down when this ran (the scheduled
-- syncs send them on their next tick, if they still pay and still have a
-- General Manager or Hotel Admin):
--
--   update public.pms_connections
--      set outage_notice_at = null
--    where down_since is not null;
--
-- Nothing else should be counting refusals yet:
--
--   select pms_type, count(*) filter (where auth_failures > 0) as counting
--     from public.pms_connections group by 1;
