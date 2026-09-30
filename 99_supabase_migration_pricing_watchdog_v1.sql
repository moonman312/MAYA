-- ============================================================================
-- MAYA: the pricing watchdog (A11), v1
-- ============================================================================
--
-- Decided by Jake on 2026-09-29 (audit item A11): something outside the
-- scheduled sync functions has to notice when pricing stops. Every alert
-- MAYA had was raised from inside the job that was not running, so a secret
-- changed in one place, a function that fails to start, or a cron call that
-- is refused within milliseconds left Slack silent while no hotel was read,
-- priced or sent to.
--
-- This file adds:
--
--   1. hotel_pricing_state.failed_runs (with last_failed_at and last_error):
--      runs that failed in a row, counted by pricing_run_failed(), which the
--      tick calls when a run stops or cannot be recorded, and set back to 0
--      by pricing_run_done() when a run that priced nights is recorded (an
--      idle heartbeat leaves it: a tick with nothing to price proves nothing
--      about pricing). The tick's own alert (pricing-tick.ts,
--      alertPricingFailing) now goes out at the third failure in a row as
--      well as after 15 minutes without a run that priced.
--
--   2. pricing_watchdog(): the check pg_cron runs every 10 minutes, in the
--      database, with no edge function in the way. For every live or
--      simulating hotel that is active, not a test hotel, not purged, past
--      setup, entitled (no subscription row, or trialing / active /
--      past_due, as the syncs decide) and connected to a property system
--      (any status but pending), it asks two questions:
--
--        behind     no pricing run has finished for 30 minutes: neither
--                   hotel_pricing_state.last_ok_run_at nor the newest
--                   evaluation_run_log row is younger than that (a hotel that
--                   never ran counts from when it went live, or was created);
--        pass_late  it is 2 hours or more into the hotel's day (its own time
--                   zone) and today's daily pass has not finished: no pass
--                   started today, or the pass on record is still running
--                   after 2 hours. Same grace as Pilot health
--                   (PASS_GRACE_MINUTES) and the push (MAYA_PASS_MAX_LAG_MINUTES).
--
--      A live hotel is critical, a simulating one is warn, and the floor is
--      the second argument (critical by default, 'warn' to hear about
--      simulating hotels too), the same words as MAYA_ALERT_MIN_SEVERITY.
--
--      It posts through the same channel the edge code uses (alerting.ts):
--      the Slack incoming webhook, read from Vault under the name
--      maya_alert_webhook (SQL cannot read the function secrets; the address
--      is stored twice on purpose, so the watchdog still speaks when every
--      function is down), the same JSON body ({text, severity, key, hotelId}),
--      through pg_net (net.http_post, asynchronous: the request is queued and
--      sent by pg_net's worker). Dedupe and recovery use the rows alerting.ts
--      already keeps in platform_audit_events: alert.raised under the key
--      pricing-watchdog:<hotel id> is written when a line goes out, and no
--      second line goes out for the key while that one is under 6 hours old
--      (DEDUPE_WINDOW_MS) and still open; a hotel that is fine again after a
--      line went out gets one recovery line (alert.recovered), and nothing
--      more until it is stuck again, when it is told at once: an outage that
--      comes back an hour after it cleared is a new outage, not a repeat.
--      While the sync's own alert for the hotel is out (pricing-failing:,
--      pms_reads_failing:, or pms_disconnected: raised in the last 6 hours
--      and not recovered since), the watchdog says nothing for it: the
--      channel has already been told why, and a second line for one outage
--      is noise. The tick's alert is not written when it could not be sent,
--      so a hotel whose function cannot reach the channel is still covered
--      here.
--
--      It also reports its own channel to platform_audit_events as
--      alert.channel under the name pricing-watchdog (state ready, missing
--      or not_https, as recordAlertChannel does for the functions), so the
--      Pilot health page's "Alerts:" line says when the Vault secret is not
--      set.
--
--      Called with p_post false it changes nothing and returns what it
--      found, which is how /api/status answers "down": any live hotel
--      behind is down, a late pass or a simulating hotel behind is degraded,
--      test hotels never count.
--
--   3. An index on platform_audit_events for the alert keys, which the edge
--      code's dedupe (raiseAlert, raiseRecovery, recordAlertChannel) looks up
--      by event_type and entity_id too.
--
-- pricing_run_done is restated whole (same signature, same grants) with the
-- one change in 1; everything else in it is as 99_supabase_migration_pricing_cadence_v1.sql
-- left it. No policy on a table changes; hotel_pricing_state keeps its row
-- level security (service role only). Safe to run more than once. Cron:
-- supabase/cron/pricing-watchdog-every-10-min.sql.example.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Failed runs in a row
-- ----------------------------------------------------------------------------

alter table public.hotel_pricing_state
  add column if not exists failed_runs integer not null default 0,
  add column if not exists last_failed_at timestamptz,
  add column if not exists last_error text;

comment on column public.hotel_pricing_state.failed_runs is
  'Pricing runs that failed in a row (pricing_run_failed); 0 again when a run that '
  'priced nights is recorded. An idle tick leaves it.';
comment on column public.hotel_pricing_state.last_failed_at is
  'When a pricing run of this hotel last failed.';
comment on column public.hotel_pricing_state.last_error is
  'What the last failed run said, first 300 characters.';

-- One more failed run: the count after it. The tick calls this when a run
-- stopped before it published, or priced but could not be recorded.
create or replace function public.pricing_run_failed(p_hotel_id uuid, p_error text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Only the scheduled sync records failed pricing runs'
      using errcode = '42501';
  end if;

  insert into public.hotel_pricing_state (hotel_id, failed_runs, last_failed_at, last_error)
  select p_hotel_id, 1, now(), left(coalesce(p_error, ''), 300)
   where exists (select 1 from public.hotels h where h.id = p_hotel_id)
  on conflict (hotel_id) do update
     set failed_runs = public.hotel_pricing_state.failed_runs + 1,
         last_failed_at = now(),
         last_error = left(coalesce(excluded.last_error, ''), 300),
         updated_at = now()
  returning failed_runs into v_count;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.pricing_run_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.pricing_run_failed(uuid, text) to service_role;

-- pricing_run_done, as 99_supabase_migration_pricing_cadence_v1.sql wrote it,
-- with one change: a run that priced nights sets failed_runs back to 0; an
-- idle heartbeat leaves it.
create or replace function public.pricing_run_done(p_hotel_id uuid, p_run jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at     timestamptz := (p_run->>'at')::timestamptz;
  v_first  date := (p_run->>'first')::date;
  v_last   date := (p_run->>'last')::date;
  v_nights date[] := coalesce(
    (select array_agg(value::date) from jsonb_array_elements_text(coalesce(p_run->'nights', '[]'::jsonb))),
    '{}'::date[]
  );
  v_momentum date[] := coalesce(
    (select array_agg(distinct value::date) from jsonb_array_elements_text(coalesce(p_run->'momentum', '[]'::jsonb))),
    '{}'::date[]
  );
  -- A JSON null is no pass step, the same as the key left out.
  v_pass   jsonb := nullif(p_run->'pass', 'null'::jsonb);
  v_cleared integer := 0;
  v_kept   integer := 0;
  v_moved  boolean := null;
  v_ms     numeric := nullif(p_run->>'ms_per_night', '')::numeric;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Only the scheduled sync records pricing runs'
      using errcode = '42501';
  end if;
  if v_at is null or v_first is null or v_last is null then
    raise exception 'pricing_run_done needs at, first and last' using errcode = '22023';
  end if;

  -- Marks the run read and priced, unless marked again since.
  with read as (
    select x.stay_date, x.mark_seq
      from jsonb_to_recordset(coalesce(p_run->'dirty', '[]'::jsonb)) as x(stay_date date, mark_seq bigint)
     where x.stay_date = any(v_nights)
  ), gone as (
    delete from public.pricing_dirty_nights d
     using read r
     where d.hotel_id = p_hotel_id
       and d.stay_date = r.stay_date
       and d.mark_seq <= r.mark_seq
    returning 1
  )
  select count(*) into v_cleared from gone;

  -- Priced, but marked again while the run worked: what is left waiting is
  -- no older than this run.
  update public.pricing_dirty_nights d
     set first_marked_at = greatest(d.first_marked_at, v_at)
   where d.hotel_id = p_hotel_id
     and d.stay_date = any(v_nights);
  get diagnostics v_kept = row_count;

  -- Past nights, and nights past the window (the pass covers them as they
  -- come into it).
  delete from public.pricing_dirty_nights d
   where d.hotel_id = p_hotel_id and (d.stay_date < v_first or d.stay_date > v_last);

  -- Nights the run could not fully write come back next tick, and so do the
  -- nights where it changed what the next run reads.
  perform public.pricing_mark_many(
    array_agg(p_hotel_id),
    array_agg(value::date),
    'retry'
  )
  from jsonb_array_elements_text(coalesce(p_run->'failed', '[]'::jsonb));
  perform public.pricing_mark_many(
    array_agg(p_hotel_id),
    array_agg(value::date),
    'follow_up'
  )
  from jsonb_array_elements_text(coalesce(p_run->'again', '[]'::jsonb));

  insert into public.hotel_pricing_state (hotel_id)
  select p_hotel_id where exists (select 1 from public.hotels h where h.id = p_hotel_id)
  on conflict (hotel_id) do nothing;

  if v_pass is not null and coalesce((v_pass->>'start')::boolean, false) then
    update public.hotel_pricing_state s
       set pass_date = (v_pass->>'date')::date,
           pass_cursor = nullif(v_pass->>'next', '')::date,
           pass_started_at = v_at,
           pass_completed_at = case when nullif(v_pass->>'next', '') is null then v_at else null end,
           pass_reason = v_pass->>'reason',
           pass_horizon_days = nullif(v_pass->>'horizon', '')::integer,
           pass_reprice_seq = coalesce(nullif(v_pass->>'reprice_seq', '')::bigint, s.pass_reprice_seq)
     where s.hotel_id = p_hotel_id;
    v_moved := found;
  elsif v_pass is not null then
    update public.hotel_pricing_state s
       set pass_cursor = nullif(v_pass->>'next', '')::date,
           pass_completed_at = case when nullif(v_pass->>'next', '') is null then v_at else null end
     where s.hotel_id = p_hotel_id
       and s.pass_date = (v_pass->>'date')::date
       and s.pass_cursor = (v_pass->>'from')::date;
    v_moved := found;
  end if;

  -- Each night's momentum flag is the one its latest pricing found: the
  -- nights this run priced take this run's answer, the others keep theirs.
  update public.hotel_pricing_state s
     set last_ok_run_at = greatest(coalesce(s.last_ok_run_at, v_at), v_at),
         -- v1 of the watchdog: a run that priced nights ends the failure streak.
         failed_runs = case when coalesce((p_run->>'idle')::boolean, false) then s.failed_runs else 0 end,
         momentum_nights = (
           select coalesce(array_agg(distinct m order by m), '{}'::date[])
             from (
               select k.m from unnest(s.momentum_nights) as k(m)
                where k.m >= v_first and not (k.m = any(v_nights))
               union
               select n.m from unnest(v_momentum) as n(m)
             ) u(m)
         ),
         ms_per_night = case
           when v_ms is null then s.ms_per_night
           when s.ms_per_night is null then v_ms
           else round(s.ms_per_night * 0.8 + v_ms * 0.2, 3)
         end,
         updated_at = now()
   where s.hotel_id = p_hotel_id;

  if coalesce((p_run->>'idle')::boolean, false) and p_run->>'run_id' is not null then
    insert into public.evaluation_run_log
      (hotel_id, evaluation_run_id, evaluated_at, cells_checked, cells_changed, run_kind, nights_priced)
    values (p_hotel_id, (p_run->>'run_id')::uuid, v_at, 0, 0, 'idle', 0)
    on conflict (hotel_id, evaluation_run_id) do nothing;
  end if;

  return jsonb_build_object(
    'cleared', v_cleared,
    'kept', v_kept,
    'pass_moved', v_moved
  );
end;
$$;

revoke all on function public.pricing_run_done(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.pricing_run_done(uuid, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- 2. The watchdog
-- ----------------------------------------------------------------------------

-- The alert keys: what raiseAlert, raiseRecovery and recordAlertChannel
-- (alerting.ts) and the watchdog look up, by event type and key, newest
-- first.
create index if not exists idx_platform_audit_events_alert_key
  on public.platform_audit_events (entity_id, created_at desc)
  where event_type in ('alert.raised', 'alert.recovered', 'alert.channel');

-- The hotel's wall clock. A time zone name the database does not know
-- counts as UTC rather than stopping the whole check.
create or replace function public.pricing_watchdog_local_time(p_tz text, p_now timestamptz)
returns timestamp
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return p_now at time zone coalesce(nullif(p_tz, ''), 'UTC');
exception when others then
  return p_now at time zone 'UTC';
end;
$$;

revoke all on function public.pricing_watchdog_local_time(text, timestamptz) from public, anon, authenticated;
grant execute on function public.pricing_watchdog_local_time(text, timestamptz) to service_role;

-- One row per hotel watched, with what was found and what was done about it
-- (action): alerted, deduped (a line went out in the last 6 hours), covered
-- (the sync's own alert for the hotel is out), below_min_severity, no_webhook
-- (nothing in Vault under maya_alert_webhook), post_failed (pg_net refused
-- the request; tried again next time), recovered, ok, or dry_run (p_post
-- false: nothing written or sent).
create or replace function public.pricing_watchdog(
  p_post boolean default true,
  p_min_severity text default 'critical',
  p_now timestamptz default now()
)
returns table (
  hotel_id uuid,
  name text,
  -- live or simulation
  mode text,
  -- critical for a live hotel, warn for a simulating one
  severity text,
  behind boolean,
  pass_late boolean,
  -- the newer of hotel_pricing_state.last_ok_run_at and the newest run log row
  last_run_at timestamptz,
  minutes_since_run integer,
  pass_date date,
  pass_finished boolean,
  hours_into_day numeric,
  failed_runs integer,
  -- pms_connections.sync_failures: failed reads in a row
  reads_failing integer,
  last_read_at timestamptz,
  alert_key text,
  action text,
  detail text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := (select auth.role());
  v_min text := case when lower(coalesce(p_min_severity, '')) = 'warn' then 'warn' else 'critical' end;
  v_window constant interval := interval '6 hours';
  v_behind_after constant interval := interval '30 minutes';
  v_pass_grace constant interval := interval '2 hours';
  v_url text;
  v_channel text;
  v_rep_at timestamptz;
  v_rep_state text;
  v_rep_min text;
  r record;
  v_local timestamp;
  v_today date;
  v_hours numeric;
  v_last_run timestamptz;
  v_since timestamptz;
  v_minutes integer;
  v_behind boolean;
  v_late boolean;
  v_pass_finished boolean;
  v_sev text;
  v_key text;
  v_raised_at timestamptz;
  v_recovered_at timestamptz;
  v_open boolean;
  v_covered boolean;
  v_action text;
  v_title text;
  v_detail text;
  v_text text;
  v_parts text[];
begin
  -- pg_cron and psql carry no JWT; every PostgREST request does.
  if v_role is not null and v_role <> 'service_role' then
    raise exception 'Only the scheduled watchdog and the service role run the pricing watchdog'
      using errcode = '42501';
  end if;

  -- The channel: the alert webhook from Vault, or nothing. Vault missing or
  -- unreadable is the same as the secret not being there.
  begin
    select s.decrypted_secret into v_url
      from vault.decrypted_secrets s
     where s.name = 'maya_alert_webhook'
     limit 1;
  exception when others then
    v_url := null;
  end;
  v_channel := case
    when nullif(v_url, '') is null then 'missing'
    when v_url not like 'https://%' then 'not_https'
    else 'ready'
  end;
  if v_channel <> 'ready' then
    v_url := null;
  end if;

  -- Say what the channel is, the way the functions do (alert.channel): when
  -- it changed, or nothing was said for 6 hours.
  if p_post then
    select e.created_at, e.detail->>'state', e.detail->>'min_severity'
      into v_rep_at, v_rep_state, v_rep_min
      from public.platform_audit_events e
     where e.event_type = 'alert.channel'
       and e.entity_id = 'pricing-watchdog'
     order by e.created_at desc
     limit 1;
    if v_rep_at is null
       or v_rep_state is distinct from v_channel
       or v_rep_min is distinct from v_min
       or v_rep_at <= p_now - v_window then
      insert into public.platform_audit_events (event_type, entity_type, entity_id, detail, created_at)
      values ('alert.channel', 'alert_channel', 'pricing-watchdog',
              jsonb_build_object('state', v_channel, 'min_severity', v_min, 'fn', 'pricing-watchdog', 'source', 'vault'),
              p_now);
    end if;
  end if;

  for r in
    select h.id,
           h.name,
           h.timezone,
           h.created_at,
           case when hs.simulation_mode = false then 'live' else 'simulation' end as mode,
           hs.live_since,
           ps.last_ok_run_at,
           ps.pass_date,
           ps.pass_started_at,
           ps.pass_completed_at,
           coalesce(ps.failed_runs, 0) as failed_runs,
           ps.last_error,
           pc.pms_type,
           pc.last_sync_at,
           coalesce(pc.sync_failures, 0) as sync_failures,
           (select max(l.evaluated_at) from public.evaluation_run_log l where l.hotel_id = h.id) as last_logged_at
      from public.hotels h
      left join public.hotel_settings hs on hs.hotel_id = h.id
      left join public.hotel_subscriptions s on s.hotel_id = h.id
      left join public.hotel_pricing_state ps on ps.hotel_id = h.id
      join lateral (
        select c.pms_type, c.last_sync_at, c.sync_failures
          from public.pms_connections c
         where c.hotel_id = h.id
           and c.status <> 'pending'
         order by (c.status = 'connected') desc, c.updated_at desc, c.created_at desc
         limit 1
      ) pc on true
     where h.is_active
       and h.setup_pending_at is null
       and h.data_purged_at is null
       and not h.is_test
       -- As the syncs decide (billing/entitlement.ts): no row is allowed.
       and (s.hotel_id is null or s.status in ('trialing', 'active', 'past_due'))
     order by h.name, h.id
  loop
    v_local := public.pricing_watchdog_local_time(r.timezone, p_now);
    v_today := v_local::date;
    v_hours := round((extract(epoch from (v_local - date_trunc('day', v_local))) / 3600)::numeric, 2);

    -- greatest() leaves a null out.
    v_last_run := greatest(r.last_ok_run_at, r.last_logged_at);
    v_since := coalesce(v_last_run, case when r.mode = 'live' then r.live_since end, r.created_at);
    v_behind := v_since < p_now - v_behind_after;
    v_minutes := case when v_last_run is null then null
                      else floor(extract(epoch from (p_now - v_last_run)) / 60)::integer end;

    v_pass_finished := coalesce(r.pass_date = v_today and r.pass_completed_at is not null, false);
    v_late := coalesce(
      v_hours >= 2
      and not v_pass_finished
      and (
        (r.pass_date is null and coalesce(r.live_since, r.created_at) < p_now - v_pass_grace)
        or r.pass_date < v_today
        or (r.pass_date = v_today and coalesce(r.pass_started_at, p_now) < p_now - v_pass_grace)
      ), false);

    v_sev := case when r.mode = 'live' then 'critical' else 'warn' end;
    v_key := 'pricing-watchdog:' || r.id::text;
    select max(e.created_at) into v_raised_at
      from public.platform_audit_events e
     where e.event_type = 'alert.raised' and e.entity_id = v_key;
    select max(e.created_at) into v_recovered_at
      from public.platform_audit_events e
     where e.event_type = 'alert.recovered' and e.entity_id = v_key;
    v_open := v_raised_at is not null and (v_recovered_at is null or v_recovered_at < v_raised_at);

    v_parts := '{}'::text[];
    if v_behind then
      v_parts := array_append(v_parts, case
        when v_last_run is null then 'No pricing run has ever finished for this hotel.'
        else format('No pricing run has finished for %s minutes (the last at %s).',
                    v_minutes, to_char(v_last_run at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z')
      end);
    end if;
    if v_late then
      v_parts := array_append(v_parts, format('Today''s pass (%s) has not finished, %s hours into the hotel day%s.',
        v_today, v_hours,
        case
          when r.pass_date is null then '; no pass has ever run'
          when r.pass_date < v_today then format('; the last pass on record is for %s', r.pass_date)
          else format('; it started at %s', to_char(r.pass_started_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z')
        end));
    end if;
    if r.failed_runs > 0 then
      v_parts := array_append(v_parts, case
        when r.failed_runs = 1 then 'The last run failed'
        else format('The last %s runs failed in a row', r.failed_runs)
      end || coalesce(': ' || r.last_error, '') || '.');
    end if;
    if r.sync_failures > 0 then
      v_parts := array_append(v_parts, format('Reads from %s have failed %s in a row; the last good read was %s.',
        r.pms_type,
        case when r.sync_failures = 1 then 'once' else r.sync_failures || ' times' end,
        case when r.last_sync_at is null then 'never'
             else floor(extract(epoch from (p_now - r.last_sync_at)) / 60)::integer || ' minutes ago' end));
    end if;
    if r.mode <> 'live' then
      v_parts := array_append(v_parts, 'The hotel is simulating: nothing is sent to its property system.');
    end if;
    v_detail := array_to_string(v_parts, ' ');

    if v_behind or v_late then
      v_title := case
        when v_behind and v_late then 'Pricing is behind and today''s pass is late'
        when v_behind then 'Pricing is behind'
        else 'Today''s pass is late'
      end || ' for ' || r.name;
      v_text := format(E'%s *MAYA %s* — %s\n> %s\n> hotel `%s`',
        case when v_sev = 'critical' then '🔴' else '🟠' end, v_sev, v_title, v_detail, r.id);

      if not p_post then
        v_action := 'dry_run';
      elsif v_sev = 'warn' and v_min <> 'warn' then
        v_action := 'below_min_severity';
      elsif v_open and v_raised_at > p_now - v_window then
        v_action := 'deduped';
      else
        -- The sync's own alert for this hotel, out in the window and not
        -- recovered since: the channel has already been told why.
        select exists (
          select 1
            from public.platform_audit_events e
           where e.event_type = 'alert.raised'
             and e.created_at > p_now - v_window
             and e.entity_id in ('pricing-failing:' || r.id::text,
                                 'pms_reads_failing:' || r.pms_type::text || ':' || r.id::text,
                                 'pms_disconnected:' || r.pms_type::text || ':' || r.id::text)
             and not exists (
               select 1 from public.platform_audit_events x
                where x.event_type = 'alert.recovered'
                  and x.entity_id = e.entity_id
                  and x.created_at >= e.created_at
             )
        ) into v_covered;
        if v_covered then
          v_action := 'covered';
        elsif v_url is null then
          v_action := 'no_webhook';
        else
          begin
            perform net.http_post(
              url := v_url,
              body := jsonb_build_object('text', v_text, 'severity', v_sev, 'key', v_key, 'hotelId', r.id),
              headers := '{"Content-Type": "application/json"}'::jsonb,
              timeout_milliseconds := 8000
            );
            insert into public.platform_audit_events (event_type, entity_type, entity_id, hotel_id, detail, created_at)
            values ('alert.raised', 'alert', v_key, r.id,
                    jsonb_build_object('severity', v_sev, 'title', v_title, 'source', 'pricing_watchdog'),
                    p_now);
            v_action := 'alerted';
          exception when others then
            v_action := 'post_failed';
            v_detail := sqlerrm;
          end;
        end if;
      end if;
    elsif p_post and v_open then
      -- Fine again after a line went out: one recovery line.
      v_title := 'Pricing is running again for ' || r.name;
      v_detail := format('A pricing run finished at %s. %s',
        to_char(v_last_run at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z',
        case when v_pass_finished then 'Today''s pass has finished.' else 'Today''s pass is not late.' end);
      v_text := format(E'🟢 *MAYA recovered* — %s\n> %s\n> hotel `%s`', v_title, v_detail, r.id);
      if v_url is null then
        v_action := 'no_webhook';
      else
        begin
          perform net.http_post(
            url := v_url,
            body := jsonb_build_object('text', v_text, 'severity', 'recovered', 'key', v_key, 'hotelId', r.id),
            headers := '{"Content-Type": "application/json"}'::jsonb,
            timeout_milliseconds := 8000
          );
          insert into public.platform_audit_events (event_type, entity_type, entity_id, hotel_id, detail, created_at)
          values ('alert.recovered', 'alert', v_key, r.id,
                  jsonb_build_object('title', v_title, 'source', 'pricing_watchdog'),
                  p_now);
          v_action := 'recovered';
        exception when others then
          v_action := 'post_failed';
          v_detail := sqlerrm;
        end;
      end if;
    else
      v_action := 'ok';
      v_detail := nullif(v_detail, '');
    end if;

    hotel_id := r.id;
    name := r.name;
    mode := r.mode;
    severity := v_sev;
    behind := v_behind;
    pass_late := v_late;
    last_run_at := v_last_run;
    minutes_since_run := v_minutes;
    pass_date := r.pass_date;
    pass_finished := v_pass_finished;
    hours_into_day := v_hours;
    failed_runs := r.failed_runs;
    reads_failing := r.sync_failures;
    last_read_at := r.last_sync_at;
    alert_key := v_key;
    action := v_action;
    detail := v_detail;
    return next;
  end loop;
end;
$$;

comment on function public.pricing_watchdog(boolean, text, timestamptz) is
  'Every 10 minutes by pg_cron: one row per live or simulating, entitled, '
  'non-test hotel with a property system, saying whether no pricing run has '
  'finished for 30 minutes (behind) or today''s daily pass has not finished 2 '
  'hours into the hotel day (pass_late), and what was done: a line to the '
  'alert webhook in Vault (maya_alert_webhook) through pg_net, once per hotel '
  'per 6 hours, with a recovery line when it clears; nothing while the sync''s '
  'own alert for the hotel is out. p_post false only reports (the status '
  'page). See 99_supabase_migration_pricing_watchdog_v1.sql.';

revoke all on function public.pricing_watchdog(boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.pricing_watchdog(boolean, text, timestamptz) to service_role;

commit;
