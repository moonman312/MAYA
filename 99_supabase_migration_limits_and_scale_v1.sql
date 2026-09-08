-- Limits, throttles, and a sync loop that scales past one invocation.
--
-- Three things, all cheap at 7 hotels and none needing a rewrite at 20,000:
--   1. The 40-rule cap, which until now existed only in the design document.
--   2. A rate-limit counter the API can use without new infrastructure.
--   3. Claim-based work distribution for the scheduled syncs.
--
-- Run any time. Idempotent.


/* ═══════════════════════════════════════════════════════════════════════════
   1. Rules per property
   ═══════════════════════════════════════════════════════════════════════════

   40 was always the intended ceiling and nothing enforced it. It matters for
   cost as much as for sanity: the engine evaluates every active rule against
   every room type and every date in the horizon, so rule count is a direct
   multiplier on the most expensive loop in the system.

   Counted over ACTIVE rules only. Someone who has switched a rule off has
   already stopped paying for it in compute, so making them delete it to add
   another would be a limit that punishes tidiness.                            */

create or replace function public.enforce_rule_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_count integer;
  cap constant integer := 40;
begin
  -- Only a rule arriving into the active state can breach the cap.
  if tg_op = 'UPDATE' and not (new.is_active and not old.is_active) then
    return new;
  end if;
  if tg_op = 'INSERT' and not new.is_active then
    return new;
  end if;

  -- Lock the hotel's rules so two concurrent inserts cannot both see 39.
  perform 1 from hotels where id = new.hotel_id for update;

  select count(*) into active_count
    from pricing_rules
   where hotel_id = new.hotel_id
     and is_active
     and (tg_op = 'INSERT' or id <> new.id);

  if active_count >= cap then
    raise exception 'This property already has % active rules, which is the maximum.', cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_pricing_rules_limit on pricing_rules;
create trigger trg_pricing_rules_limit
  before insert or update on pricing_rules
  for each row
  execute function public.enforce_rule_limit();

comment on function public.enforce_rule_limit() is
  'Caps active pricing rules at 40 per property. Rule count multiplies the engine''s per-room-type-per-date work, so this is a cost control as well as a product limit.';


/* ═══════════════════════════════════════════════════════════════════════════
   2. Request throttling
   ═══════════════════════════════════════════════════════════════════════════

   No new infrastructure on purpose. A Redis for seven hotels is a second thing
   to run, pay for and have go down; Postgres counts perfectly well at any
   volume this product will see for years, and the row is one upsert.

   Fixed windows rather than sliding: a sliding window needs the timestamps
   kept, and the difference only matters to an attacker trying to land exactly
   2x the limit across a boundary — which is still bounded, still small, and not
   worth the write amplification.                                              */

create table if not exists public.rate_limit_counters (
  bucket_key   text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket_key, window_start)
);

alter table public.rate_limit_counters enable row level security;
-- No policy at all: the service role bypasses RLS and nothing else may read a
-- table that reveals how often other people are calling us.
revoke all on public.rate_limit_counters from anon, authenticated;

/**
 * One hit against a bucket. Returns true when the caller is within budget.
 *
 * Atomic by construction — the insert-or-increment is a single statement, so
 * concurrent callers cannot both read the same count and both be allowed.
 */
create or replace function public.rate_limit_hit(
  p_key      text,
  p_limit    integer,
  p_window_seconds integer
)
returns table (allowed boolean, hits integer, resets_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  w_start timestamptz;
  n integer;
begin
  -- Floor the clock to the window, so every caller in the same window agrees
  -- which row they are incrementing.
  w_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  insert into rate_limit_counters (bucket_key, window_start, hits)
    values (p_key, w_start, 1)
  on conflict (bucket_key, window_start)
    do update set hits = rate_limit_counters.hits + 1
  returning rate_limit_counters.hits into n;

  return query select n <= p_limit, n, w_start + make_interval(secs => p_window_seconds);
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

/**
 * Old windows are dead weight. Called opportunistically by the limiter rather
 * than scheduled, so there is no cron to forget to set up.
 */
create or replace function public.rate_limit_sweep(p_older_than_minutes integer default 60)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from rate_limit_counters
   where window_start < now() - make_interval(mins => p_older_than_minutes);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.rate_limit_sweep(integer) from public, anon, authenticated;
grant execute on function public.rate_limit_sweep(integer) to service_role;


/* ═══════════════════════════════════════════════════════════════════════════
   3. Distributing the scheduled sync
   ═══════════════════════════════════════════════════════════════════════════

   The syncs currently SELECT every connection of a PMS type and loop them in
   one invocation. That is fine at 7 hotels and impossible at 20,000: one Edge
   Function has a wall clock, and the tail of the list simply never runs.

   The fix is the pattern the import worker already uses — claim a bounded batch
   under a lease, with FOR UPDATE SKIP LOCKED so concurrent workers take
   disjoint work. Scaling is then a configuration change rather than a redesign:
   one invocation per tick at 7 hotels, forty at 20,000, and no worker ever
   knows or cares how many others exist.

   The lease is what makes a crashed worker safe. It expires, and the next tick
   picks the hotel up rather than leaving it stranded.                          */

alter table pms_connections
  add column if not exists sync_due_at      timestamptz not null default now(),
  add column if not exists sync_lease_until timestamptz,
  add column if not exists sync_lease_owner text,
  add column if not exists sync_failures    integer not null default 0;

comment on column pms_connections.sync_due_at is
  'When this connection next wants syncing. Workers claim the overdue ones oldest-first.';
comment on column pms_connections.sync_lease_until is
  'Held by the worker currently syncing it. Expiry is what makes a crashed worker recoverable rather than a stranded hotel.';
comment on column pms_connections.sync_failures is
  'Consecutive failures. Drives exponential backoff so one broken connection stops costing a full-rate retry every tick.';

-- The claim query's exact shape: due, unleased, of this type.
create index if not exists idx_pms_connections_sync_due
  on pms_connections(pms_type, sync_due_at)
  where status <> 'disconnected';

/**
 * Claim up to p_limit connections that are due, and lease them.
 *
 * SKIP LOCKED is the whole trick: two workers running the same statement at the
 * same instant take different rows instead of blocking on each other, so adding
 * workers adds throughput linearly with no coordination between them.
 */
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
     where c.pms_type = p_pms_type
       and c.status <> 'disconnected'
       and c.sync_due_at <= now()
       and (c.sync_lease_until is null or c.sync_lease_until < now())
     order by c.sync_due_at
     limit p_limit
     for update skip locked
  )
  update pms_connections c
     set sync_lease_until = now() + make_interval(secs => p_lease_seconds),
         sync_lease_owner = p_owner
    from due
   where c.hotel_id = due.hotel_id
     and c.pms_type = p_pms_type
  returning c.hotel_id, c.sync_failures;
end;
$$;

revoke all on function public.claim_pms_sync_batch(text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.claim_pms_sync_batch(text, integer, integer, text) to service_role;

/**
 * Release a claim and say when the connection should next be looked at.
 *
 * A failure backs off exponentially — 2, 4, 8 ... capped at an hour — so one
 * hotel with a revoked token stops costing a full-rate retry every five minutes
 * forever. Success resets it.
 */
create or replace function public.release_pms_sync(
  p_hotel_id uuid,
  p_pms_type text,
  p_ok boolean,
  p_interval_seconds integer default 300
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  fails integer;
  backoff integer;
begin
  select case when p_ok then 0 else least(sync_failures + 1, 10) end
    into fails
    from pms_connections
   where hotel_id = p_hotel_id and pms_type = p_pms_type;

  backoff := case
    when p_ok then p_interval_seconds
    else least(p_interval_seconds * power(2, fails)::integer, 3600)
  end;

  update pms_connections
     set sync_lease_until = null,
         sync_lease_owner = null,
         sync_failures = fails,
         sync_due_at = now() + make_interval(secs => backoff)
   where hotel_id = p_hotel_id and pms_type = p_pms_type;
end;
$$;

revoke all on function public.release_pms_sync(uuid, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.release_pms_sync(uuid, text, boolean, integer) to service_role;
