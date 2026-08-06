-- Who paid and then never finished setting up.
--
-- The failure mode this exists for: a property signs up excited, gets pulled onto
-- something else, and MAYA sits there billing them for nothing. They are not a
-- support ticket — nobody complains about a tool they forgot about — so unless
-- someone goes looking, the first sign is a chargeback or a cancellation.
--
-- Everything here is one SECURITY DEFINER function because the useful version of
-- this list needs auth.users (the email to reach out to, and whether it was ever
-- confirmed), and that is not reachable from PostgREST. Same shape as
-- platform_list_users in 99_supabase_migration_command_center_v2.sql.
--
-- Run AFTER: onboarding_v1, billing_v1, billing_v2_pending_hotel,
-- command_center_v2, card_reverify_v1 + v2. Idempotent.

begin;

/* ── Somewhere to record "we chased this one, it's gone" ───────────────────── */

-- On hotels rather than onboarding_states because the most common stall happens
-- before onboarding_states exists: checkout creates the hotel row, and a signup
-- that never reached the PMS connect has nothing else to hang a flag on.
alter table hotels
  add column if not exists signup_abandoned_at timestamptz,
  add column if not exists signup_abandoned_by uuid references auth.users(id) on delete set null,
  add column if not exists signup_abandoned_note text;

comment on column hotels.signup_abandoned_at is
  'Set by a platform admin who has given up on this signup finishing. Hides it '
  'from the default stalled-signups list; changes nothing about billing.';

create index if not exists idx_hotels_signup_abandoned
  on hotels(signup_abandoned_at)
  where signup_abandoned_at is not null;

-- ============================================================================
-- platform_list_stalled_signups(min_hours, include_abandoned)
-- ============================================================================
--
-- A "signup" is a hotel with a hotel_subscriptions row — it came through the paid
-- flow. It is "stalled" when it has not reached the end of onboarding and has
-- been sitting at the same step for at least p_min_hours (default a day, because
-- someone who paid this morning is mid-flow, not stuck).
--
-- The stage vocabulary deliberately extends the four steps in
-- src/lib/onboarding/step.ts. Two of them ('subscribe' and 'done') can't be
-- stalled — nothing was sold, or nothing is outstanding — and the ones that can
-- split further, because "connected but the import died" and "connected and
-- ignoring us" need different emails.
--
-- Canceled subscriptions are left out. Those are lost customers, not stuck ones,
-- and mixing them in turns a to-do list into a graveyard.

create or replace function public.platform_list_stalled_signups(
  p_min_hours int default 24,
  p_include_abandoned boolean default false
) returns table (
  hotel_id uuid,
  hotel_name text,
  -- Which step they never got past.
  stage text,
  -- When they arrived at that step. Each stage counts from its own clock, so
  -- "12 days" always means 12 days at THIS step, not 12 days since signing up.
  stuck_since timestamptz,
  stuck_hours int,
  -- Who to email, and whether that address was ever proven to exist. An
  -- unconfirmed one is likely a typo, which is its own explanation for silence.
  admin_email text,
  admin_name text,
  email_confirmed boolean,
  last_sign_in_at timestamptz,
  -- What they are being charged for something they aren't using.
  status text,
  billing_interval text,
  billed_rooms int,
  trial_end timestamptz,
  current_period_end timestamptz,
  -- Billing periods elapsed since the first real charge. Derived from the
  -- period, not from Stripe's invoice list, so it is an estimate — but it is the
  -- number that decides whether an email is overdue or premature.
  periods_billed int,
  -- A signup whose card also died needs a different conversation.
  card_verify_failed_at timestamptz,
  card_verify_last_code text,
  signup_code text,
  pms_type text,
  pms_status text,
  import_status text,
  import_phase text,
  import_error text,
  rooms_measured int,
  signup_abandoned_at timestamptz,
  signup_abandoned_note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz := now() - make_interval(hours => greatest(0, p_min_hours));
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  with sub as (
    select
      s.hotel_id,
      s.status,
      s.billing_interval,
      s.billed_rooms,
      s.trial_end,
      s.current_period_end,
      s.card_verify_failed_at,
      s.card_verify_last_code,
      s.signup_code_id,
      s.created_at,
      -- The subscription's own idea of when money started moving.
      coalesce(s.trial_end, s.created_at) as charging_since
    from hotel_subscriptions s
    where s.status <> 'canceled'
  ),
  -- The hotel's admin: the earliest active hotel_admin, which for a self-serve
  -- signup is the person who paid. Earliest rather than any, so the row doesn't
  -- change identity when they invite a colleague.
  hotel_owner as (
    select distinct on (hm.hotel_id)
      hm.hotel_id,
      hm.user_id,
      u.email::text as email,
      u.email_confirmed_at,
      u.last_sign_in_at,
      p.full_name,
      p.onboarding_path,
      p.onboarding_dismissed_at
    from hotel_memberships hm
    join auth.users u on u.id = hm.user_id
    left join profiles p on p.id = hm.user_id
    where hm.status = 'active'
      and hm.role = 'hotel_admin'
    order by hm.hotel_id, hm.created_at asc
  ),
  conn as (
    select distinct on (c.hotel_id)
      c.hotel_id, c.pms_type, c.status, c.updated_at
    from pms_connections c
    order by c.hotel_id, c.updated_at desc
  ),
  staged as (
    select
      h.id as hotel_id,
      h.name as hotel_name,
      h.setup_pending_at,
      h.signup_abandoned_at,
      h.signup_abandoned_note,
      sub.status, sub.billing_interval, sub.billed_rooms, sub.trial_end,
      sub.current_period_end, sub.card_verify_failed_at, sub.card_verify_last_code,
      sub.signup_code_id, sub.created_at, sub.charging_since,
      -- Whole billing months since money started moving, counted the way a
      -- monthly anniversary actually works: the month is not complete until the
      -- day-of-month comes round again.
      ((extract(year from now()) - extract(year from sub.charging_since)) * 12
       + (extract(month from now()) - extract(month from sub.charging_since))
       - case
           when extract(day from now()) < extract(day from sub.charging_since) then 1
           else 0
         end)::int as months_elapsed,
      ho.email, ho.full_name, ho.email_confirmed_at, ho.last_sign_in_at,
      ho.onboarding_path, ho.onboarding_dismissed_at,
      j.status as job_status, j.phase as job_phase, j.last_error as job_error,
      j.finished_at as job_finished_at, j.updated_at as job_updated_at,
      conn.pms_type, conn.status as conn_status, conn.updated_at as conn_updated_at,
      os.connected_at, os.review_completed_at, os.payment_tier_rooms,
      -- Ordered by how early in the flow the step sits, so a hotel that is stuck
      -- in more than one way is reported at the FIRST thing blocking it — which
      -- is the only one worth acting on.
      case
        when sub.status in ('incomplete', 'incomplete_expired', 'unpaid') then 'payment_incomplete'
        when h.setup_pending_at is not null then 'no_pms'
        when j.status = 'failed' then 'import_failed'
        when j.status in ('queued', 'running') then 'import_stuck'
        when ho.onboarding_path is null and ho.onboarding_dismissed_at is null then 'no_path'
        when ho.onboarding_path = 'guided' and os.review_completed_at is null then 'review_pending'
      end as stage,
      case
        when sub.status in ('incomplete', 'incomplete_expired', 'unpaid') then sub.created_at
        when h.setup_pending_at is not null then h.setup_pending_at
        when j.status = 'failed' then coalesce(j.finished_at, j.updated_at)
        when j.status in ('queued', 'running') then j.updated_at
        else coalesce(os.connected_at, conn.updated_at, sub.created_at)
      end as stuck_since
    from hotels h
    join sub on sub.hotel_id = h.id
    left join hotel_owner ho on ho.hotel_id = h.id
    left join conn on conn.hotel_id = h.id
    left join onboarding_states os on os.hotel_id = h.id
    -- Specifically the job onboarding is waiting on, NOT the hotel's most recent
    -- one. Revenue managers can trigger a PMS sync by hand, and a live property
    -- part-way through a routine re-import is not a stalled signup.
    left join import_jobs j on j.id = os.import_job_id
  )
  select
    st.hotel_id,
    -- The placeholder name checkout invents is noise in a list; the email below
    -- is the identity for a signup that never reached its PMS.
    case when st.setup_pending_at is not null then null else st.hotel_name end,
    st.stage,
    st.stuck_since,
    (extract(epoch from (now() - st.stuck_since)) / 3600)::int,
    st.email,
    st.full_name,
    st.email_confirmed_at is not null,
    st.last_sign_in_at,
    st.status,
    st.billing_interval,
    st.billed_rooms,
    st.trial_end,
    st.current_period_end,
    -- The charge at charging_since itself is payment one, so a subscription in
    -- its first month reads 1 rather than 0. A trial still running reads 0,
    -- because nothing has been taken.
    case
      when st.charging_since >= now() then 0
      when st.billing_interval = 'year' then greatest(0, st.months_elapsed) / 12 + 1
      else greatest(0, st.months_elapsed) + 1
    end,
    st.card_verify_failed_at,
    st.card_verify_last_code,
    sc.code,
    st.pms_type::text,
    st.conn_status::text,
    st.job_status::text,
    st.job_phase,
    st.job_error,
    st.payment_tier_rooms,
    st.signup_abandoned_at,
    st.signup_abandoned_note,
    st.created_at
  from staged st
  left join signup_codes sc on sc.id = st.signup_code_id
  where st.stage is not null
    and st.stuck_since <= v_cutoff
    and (p_include_abandoned or st.signup_abandoned_at is null)
  -- Longest-stuck first: that is both the most money already taken and the
  -- closest to asking for it back.
  order by st.stuck_since asc;
end;
$$;

revoke all on function public.platform_list_stalled_signups(int, boolean) from public;
grant execute on function public.platform_list_stalled_signups(int, boolean)
  to authenticated, service_role;

-- ============================================================================
-- platform_flag_signup_abandoned(hotel_id, abandoned, note)
-- ============================================================================
--
-- Only ever touches the flag. Cancelling the subscription, refunding, deleting
-- the hotel — all of that is a decision with money attached and belongs in
-- Stripe, not behind a button on a triage list.

create or replace function public.platform_flag_signup_abandoned(
  p_hotel_id uuid,
  p_abandoned boolean,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update hotels
     -- Un-flagging clears all three: a stale note under a row that is back on the
     -- list reads as current advice.
     set signup_abandoned_at =
           case when p_abandoned then coalesce(signup_abandoned_at, now()) else null end,
         signup_abandoned_by = case when p_abandoned then auth.uid() else null end,
         signup_abandoned_note =
           case when p_abandoned then nullif(btrim(coalesce(p_note, '')), '') else null end
   where id = p_hotel_id;

  if not found then
    raise exception 'No such hotel %', p_hotel_id using errcode = 'P0002';
  end if;

  perform public.platform_log_event(
    case when p_abandoned then 'signup_abandoned' else 'signup_unabandoned' end,
    'hotel', p_hotel_id::text, p_hotel_id,
    jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), ''))
  );
end;
$$;

revoke all on function public.platform_flag_signup_abandoned(uuid, boolean, text) from public;
grant execute on function public.platform_flag_signup_abandoned(uuid, boolean, text)
  to authenticated, service_role;

commit;
