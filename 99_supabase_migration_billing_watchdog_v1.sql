-- ============================================================================
-- MAYA: the billing watchdog (audit item A40), v1
-- ============================================================================
--
-- Billing problems that need a person (two live subscriptions on one
-- property, a code used past its limit after the money moved, a new card
-- declined on an overdue subscription, a property measured above 500 rooms,
-- the billing jobs refused for a missing secret, MAYA's copy of a
-- subscription found out of date) used to end in a log line nobody reads.
-- And nothing noticed when a billing job stopped running.
--
-- The app now writes each such problem to platform_audit_events as
-- billing.problem (entity_id = a stable key; detail: severity, title, detail),
-- and each run of a billing job as billing.sweep (entity_id = the job:
-- card-reverify, room-truing, stripe-reconcile), from src/lib/billing/problems.ts.
-- The app holds no alert address, and a Stripe webhook must not wait on Slack,
-- so it writes a row and this posts it.
--
-- This file adds:
--
--   1. billing_watchdog(): the check pg_cron runs every 15 minutes, in the
--      database, with no app or edge function in the way (the same reason the
--      pricing watchdog lives here). It posts through the same channel as
--      every other alert: the Slack webhook in the Vault secret
--      maya_alert_webhook, the same JSON body ({text, severity, key, hotelId}),
--      through pg_net. Dedupe and recovery use the rows alerting.ts and the
--      pricing watchdog already keep: alert.raised and alert.recovered under
--      the alert key.
--
--        jobs      once Stripe billing is in use (any hotel_subscriptions row
--                  with plan_kind 'stripe'), a job that has not reported a
--                  run for too long is a critical line: the card check after
--                  2 hours (it runs every 15 minutes and reports at least
--                  hourly), room-count truing and the nightly Stripe check
--                  after 26 hours (daily). Key billing-watchdog:<job>. No
--                  repeat within 6 hours while it stays stopped, and one
--                  recovery line when it runs again.
--        problems  each key with a billing.problem written in the last 7
--                  days and not posted since its newest occurrence is
--                  posted, at most once per key per 6 hours (a newer
--                  occurrence inside that window waits for it to pass).
--                  Severity is the problem's own; warn is only sent when the
--                  second argument is 'warn'. Problems get no recovery line.
--
--      It reports its own channel to platform_audit_events as alert.channel
--      under the name billing-watchdog (state ready, missing or not_https,
--      source vault), as the pricing watchdog does, so the Pilot health
--      "Alerts:" line says when the Vault secret is not set.
--
--      Called with p_post false it changes nothing and returns what it would
--      do (action dry_run).
--
--   2. An index on platform_audit_events for the two new kinds of row, looked
--      up by key, newest first.
--
-- No table is created, no policy changes, and platform_audit_events keeps its
-- row level security (platform admins read it; the service role writes it).
-- The function is the service role's and pg_cron's alone. Safe to run more
-- than once. Cron: supabase/cron/billing-watchdog.sql.example.
-- ============================================================================

begin;

create index if not exists idx_platform_audit_events_billing
  on public.platform_audit_events (entity_id, created_at desc)
  where event_type in ('billing.problem', 'billing.sweep');

-- One row per billing job and per problem waiting to be posted, with what was
-- done about it (action): alerted, deduped (a line for the key went out in
-- the last 6 hours), below_min_severity, no_webhook (nothing in Vault under
-- maya_alert_webhook), post_failed (pg_net refused; tried again next time),
-- recovered, ok, or dry_run (p_post false: nothing written or sent).
create or replace function public.billing_watchdog(
  p_post boolean default true,
  p_min_severity text default 'critical',
  p_now timestamptz default now()
)
returns table (
  -- job or problem
  kind text,
  alert_key text,
  severity text,
  title text,
  -- a job's last run, or a problem's newest occurrence
  last_at timestamptz,
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
  v_problem_days constant interval := interval '7 days';
  v_url text;
  v_channel text;
  v_rep_at timestamptz;
  v_rep_state text;
  v_rep_min text;
  v_in_use boolean;
  j record;
  p record;
  v_key text;
  v_last timestamptz;
  v_stale boolean;
  v_raised_at timestamptz;
  v_recovered_at timestamptz;
  v_open boolean;
  v_hotel uuid;
  v_sev text;
  v_action text;
  v_title text;
  v_detail text;
  v_text text;
begin
  -- pg_cron and psql carry no JWT; every PostgREST request does.
  if v_role is not null and v_role <> 'service_role' then
    raise exception 'Only the scheduled watchdog and the service role run the billing watchdog'
      using errcode = '42501';
  end if;

  -- The channel: the alert webhook from Vault, or nothing.
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

  if p_post then
    select e.created_at, e.detail->>'state', e.detail->>'min_severity'
      into v_rep_at, v_rep_state, v_rep_min
      from public.platform_audit_events e
     where e.event_type = 'alert.channel'
       and e.entity_id = 'billing-watchdog'
     order by e.created_at desc
     limit 1;
    if v_rep_at is null
       or v_rep_state is distinct from v_channel
       or v_rep_min is distinct from v_min
       or v_rep_at <= p_now - v_window then
      insert into public.platform_audit_events (event_type, entity_type, entity_id, detail, created_at)
      values ('alert.channel', 'alert_channel', 'billing-watchdog',
              jsonb_build_object('state', v_channel, 'min_severity', v_min, 'fn', 'billing-watchdog', 'source', 'vault'),
              p_now);
    end if;
  end if;

  -- ---------------------------------------------------------------- jobs
  select exists (select 1 from public.hotel_subscriptions s where s.plan_kind = 'stripe') into v_in_use;

  for j in
    select t.job, t.stale_after, t.label, t.cadence
      from (values
        ('card-reverify', interval '2 hours', 'The card check', 'every 15 minutes'),
        ('room-truing', interval '26 hours', 'Room-count truing', 'daily'),
        ('stripe-reconcile', interval '26 hours', 'The nightly Stripe check', 'daily')
      ) as t(job, stale_after, label, cadence)
  loop
    v_key := 'billing-watchdog:' || j.job;
    select max(e.created_at) into v_last
      from public.platform_audit_events e
     where e.event_type = 'billing.sweep' and e.entity_id = j.job and e.created_at <= p_now;
    v_stale := v_in_use and (v_last is null or v_last < p_now - j.stale_after);

    select max(e.created_at) into v_raised_at
      from public.platform_audit_events e
     where e.event_type = 'alert.raised' and e.entity_id = v_key;
    select max(e.created_at) into v_recovered_at
      from public.platform_audit_events e
     where e.event_type = 'alert.recovered' and e.entity_id = v_key;
    v_open := v_raised_at is not null and (v_recovered_at is null or v_recovered_at < v_raised_at);

    v_sev := 'critical';
    if v_stale then
      v_title := j.label || ' has stopped running';
      v_detail := case
        when v_last is null then format('%s has never reported a run (it runs %s).', j.label, j.cadence)
        else format('%s last ran at %s (it runs %s).', j.label,
                    to_char(v_last at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z', j.cadence)
      end || ' Check its cron job (cron.job_run_details), BILLING_CRON_SECRET in the app against the Vault secret billing_cron_secret, and the Vault secret maya_app_url.';
      v_text := format(E'🔴 *MAYA critical*: %s\n> %s', v_title, v_detail);

      if not p_post then
        v_action := 'dry_run';
      elsif v_open and v_raised_at > p_now - v_window then
        v_action := 'deduped';
      elsif v_url is null then
        v_action := 'no_webhook';
      else
        begin
          perform net.http_post(
            url := v_url,
            body := jsonb_build_object('text', v_text, 'severity', v_sev, 'key', v_key, 'hotelId', null),
            headers := '{"Content-Type": "application/json"}'::jsonb,
            timeout_milliseconds := 8000
          );
          insert into public.platform_audit_events (event_type, entity_type, entity_id, detail, created_at)
          values ('alert.raised', 'alert', v_key,
                  jsonb_build_object('severity', v_sev, 'title', v_title, 'source', 'billing_watchdog'),
                  p_now);
          v_action := 'alerted';
        exception when others then
          v_action := 'post_failed';
          v_detail := sqlerrm;
        end;
      end if;
    elsif p_post and v_open then
      v_title := j.label || ' is running again';
      v_detail := format('It ran at %s.', to_char(v_last at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z');
      v_text := format(E'🟢 *MAYA recovered*: %s\n> %s', v_title, v_detail);
      if v_url is null then
        v_action := 'no_webhook';
      else
        begin
          perform net.http_post(
            url := v_url,
            body := jsonb_build_object('text', v_text, 'severity', 'recovered', 'key', v_key, 'hotelId', null),
            headers := '{"Content-Type": "application/json"}'::jsonb,
            timeout_milliseconds := 8000
          );
          insert into public.platform_audit_events (event_type, entity_type, entity_id, detail, created_at)
          values ('alert.recovered', 'alert', v_key,
                  jsonb_build_object('title', v_title, 'source', 'billing_watchdog'),
                  p_now);
          v_action := 'recovered';
        exception when others then
          v_action := 'post_failed';
          v_detail := sqlerrm;
        end;
      end if;
    else
      v_title := j.label;
      v_detail := case when v_in_use then null else 'No Stripe subscription yet, so nothing is expected to run.' end;
      v_action := 'ok';
    end if;

    kind := 'job';
    alert_key := v_key;
    severity := v_sev;
    title := v_title;
    last_at := v_last;
    action := v_action;
    detail := v_detail;
    return next;
  end loop;

  -- ------------------------------------------------------------ problems
  for p in
    select distinct on (e.entity_id) e.entity_id, e.hotel_id, e.detail, e.created_at
      from public.platform_audit_events e
     where e.event_type = 'billing.problem'
       and e.entity_id is not null
       and e.created_at > p_now - v_problem_days
       and e.created_at <= p_now
     order by e.entity_id, e.created_at desc, e.id desc
  loop
    v_key := p.entity_id;
    select max(e.created_at) into v_raised_at
      from public.platform_audit_events e
     where e.event_type = 'alert.raised' and e.entity_id = v_key;
    -- Posted since its newest occurrence: nothing new to say.
    if v_raised_at is not null and v_raised_at >= p.created_at then
      continue;
    end if;

    v_sev := case when p.detail->>'severity' = 'warn' then 'warn' else 'critical' end;
    v_title := coalesce(nullif(p.detail->>'title', ''), 'A billing problem needs a person');
    v_detail := nullif(p.detail->>'detail', '');
    v_hotel := coalesce(p.hotel_id, case when (p.detail->>'hotel_id') ~ '^[0-9a-f-]{36}$' then (p.detail->>'hotel_id')::uuid end);
    v_text := format(E'%s *MAYA %s*: %s%s%s',
      case when v_sev = 'critical' then '🔴' else '🟠' end, v_sev, v_title,
      case when v_detail is null then '' else E'\n> ' || v_detail end,
      case when v_hotel is null then '' else format(E'\n> hotel `%s`', v_hotel) end);

    if not p_post then
      v_action := 'dry_run';
    elsif v_sev = 'warn' and v_min <> 'warn' then
      v_action := 'below_min_severity';
    elsif v_raised_at is not null and v_raised_at > p_now - v_window then
      v_action := 'deduped';
    elsif v_url is null then
      v_action := 'no_webhook';
    else
      begin
        perform net.http_post(
          url := v_url,
          body := jsonb_build_object('text', v_text, 'severity', v_sev, 'key', v_key, 'hotelId', v_hotel),
          headers := '{"Content-Type": "application/json"}'::jsonb,
          timeout_milliseconds := 8000
        );
        insert into public.platform_audit_events (event_type, entity_type, entity_id, hotel_id, detail, created_at)
        values ('alert.raised', 'alert', v_key, p.hotel_id,
                jsonb_build_object('severity', v_sev, 'title', v_title, 'source', 'billing_watchdog'),
                p_now);
        v_action := 'alerted';
      exception when others then
        v_action := 'post_failed';
        v_detail := sqlerrm;
      end;
    end if;

    kind := 'problem';
    alert_key := v_key;
    severity := v_sev;
    title := v_title;
    last_at := p.created_at;
    action := v_action;
    detail := v_detail;
    return next;
  end loop;
end;
$$;

revoke all on function public.billing_watchdog(boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_watchdog(boolean, text, timestamptz) to service_role;

commit;
