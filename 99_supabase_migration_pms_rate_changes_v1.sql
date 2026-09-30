-- ============================================================================
-- MAYA: what happens when a rate MAYA sent is changed in the property system, v1
-- ============================================================================
--
-- Decided by Jake on 2026-09-30. Cloudbeds' API cannot say who or which app
-- changed a rate; MAYA only knows whether a rate differs from what it sent.
-- So each property chooses, in Settings:
--
--   hotel_settings.pms_rate_changes
--     'keep'       (the default, and how MAYA always worked) a change made in
--                  Cloudbeds or ThinkReservations on a night MAYA sent to is
--                  kept as the owner's price. A rate REMOVED there (a later
--                  read returns no rate for a night an earlier read did)
--                  counts the same way: MAYA stops pricing and sending the
--                  night until a read returns a rate again.
--     'maya_wins'  such a change, or removal, is not kept. MAYA sends its own
--                  price again on the next run, through the normal push path.
--
-- What this file adds:
--
--   1. hotel_settings.pms_rate_changes, with a check and default 'keep'.
--   2. base_rate_calendar.pms_removed_at: when a read found the PMS no longer
--      has a rate for a night MAYA sent to (in 'keep'). The row keeps the
--      hotel's own rate from before MAYA's first send, so a rate that comes
--      back at MAYA's price hands the night straight back to MAYA's pricing.
--      The engine prices no night on a row that carries it, and the pricing
--      cadence's base rate trigger now marks a night when it moves.
--   3. pms_change_notices: what the change log shows and the two new emails
--      send. One row per overwrite ('overwrite': a night and room type whose
--      rate was changed or removed, the PMS's rate, null when removed, and
--      MAYA's price), and one per warning that something other than MAYA
--      seems to be changing rates ('other_tool', with how many rates changed
--      in the last 7 days). emailed_at says the email about it went out.
--      A property's members read their own; only the service role writes.
--   4. pms_change_watch: one row per property the scheduled syncs keep for
--      the two emails. change_days counts the changes found on each of the
--      last 7 days (by the property's date), other_tool_notice_at is the
--      last warning (at most one per 7 days), digest_sent_on the property
--      date the last overwrite email went out (at most one a day). Service
--      role only.
--   5. set_pms_rate_changes(hotel, mode, replace): the Settings save. Takes
--      the same check as every property setting (can_manage_hotel: Revenue
--      Manager and up, a platform admin only in God Mode) and, in one
--      transaction, switches the mode. Turning 'maya_wins' on while future
--      nights still hold a rate changed in the PMS (an open manual price with
--      source 'pms', or a rate removed there) answers with how many nights
--      and changes nothing, unless `replace` is true: then those manual
--      prices are cleared with the rules they paused let go (the same as
--      Clear on the calendar), the removed nights are handed back to MAYA,
--      and their ledger rows say MAYA's price is no longer there, so the next
--      run sends MAYA's prices. Prices typed in MAYA are never touched.
--      Turning it off changes nothing else.
--
-- The PGlite test runs this file twice (pms-rate-changes-migration-sql.test.ts).
-- Safe to run more than once: columns and tables are added only when missing,
-- every check is dropped and made again, functions are replaced. The app
-- reads the new columns when they are there and works as before when they
-- are not, so deploy order does not matter.
-- ============================================================================

begin;

-- ── 1. The setting ──────────────────────────────────────────────────────────

alter table public.hotel_settings
  add column if not exists pms_rate_changes text not null default 'keep';

alter table public.hotel_settings drop constraint if exists hotel_settings_pms_rate_changes_check;
alter table public.hotel_settings add constraint hotel_settings_pms_rate_changes_check
  check (pms_rate_changes in ('keep', 'maya_wins'));

comment on column public.hotel_settings.pms_rate_changes is
  'When a rate MAYA sent is changed or removed in the property system: keep (the default) keeps the change as '
  'the owner''s price; maya_wins sends MAYA''s price again. Cloudbeds and ThinkReservations; Mews is not read.';

-- ── 2. A rate removed in the property system ───────────────────────────────

alter table public.base_rate_calendar
  add column if not exists pms_removed_at timestamptz;

comment on column public.base_rate_calendar.pms_removed_at is
  'When a read found the property system no longer has a rate for this night, which MAYA had sent to (setting '
  'keep). The night is not priced while it is set; price stays the hotel''s own rate from before MAYA''s first send. '
  'Cleared when a read returns a rate for the night again.';

-- The pricing cadence prices a night again when its base rate moves. A rate
-- removed, or back again, moves it too.
create or replace function public.pricing_mark_base_rates_upd()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(c.hotel_id), array_agg(c.stay_date), 'base_rate')
    from (
      select distinct n.hotel_id, n.stay_date
        from old_rows o
        join new_rows n
          on n.hotel_id = o.hotel_id and n.stay_date = o.stay_date and n.room_type_id = o.room_type_id
       where n.price is distinct from o.price
          or n.pms_removed_at is distinct from o.pms_removed_at
    ) c;
  return null;
end;
$$;

-- ── 3. What the change log shows and the emails send ───────────────────────

create table if not exists public.pms_change_notices (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  pms_type public.pms_type not null,
  kind text not null,
  found_at timestamptz not null default now(),
  stay_date date,
  room_type_id uuid references public.room_types(id) on delete cascade,
  pms_rate numeric(10,2),
  maya_price numeric(10,2),
  rates integer,
  emailed_at timestamptz
);

alter table public.pms_change_notices drop constraint if exists pms_change_notices_kind_check;
alter table public.pms_change_notices add constraint pms_change_notices_kind_check
  check (kind in ('overwrite', 'other_tool'));

alter table public.pms_change_notices drop constraint if exists pms_change_notices_shape_check;
alter table public.pms_change_notices add constraint pms_change_notices_shape_check
  check (
    (kind = 'overwrite'
      and stay_date is not null and room_type_id is not null and maya_price is not null and rates is null)
    or (kind = 'other_tool'
      and rates is not null and rates > 0
      and stay_date is null and room_type_id is null and pms_rate is null and maya_price is null)
  );

create index if not exists idx_pms_change_notices_hotel_found
  on public.pms_change_notices (hotel_id, found_at desc);
create index if not exists idx_pms_change_notices_unemailed
  on public.pms_change_notices (pms_type, found_at)
  where emailed_at is null;

comment on table public.pms_change_notices is
  'Change log items about rates changed in the property system: an overwrite (MAYA sent its price again over a '
  'rate changed or removed there, pms_rate null when removed) or a warning that something other than MAYA seems '
  'to be changing rates. emailed_at: the email about it went out.';

alter table public.pms_change_notices enable row level security;

revoke all on public.pms_change_notices from public, anon, authenticated, service_role;
grant select on public.pms_change_notices to authenticated;
grant select, insert, update, delete on public.pms_change_notices to service_role;

drop policy if exists pms_change_notices_read on public.pms_change_notices;
create policy pms_change_notices_read on public.pms_change_notices
  for select using (public.is_hotel_accessible(hotel_id));

-- ── 4. What the emails keep track of ───────────────────────────────────────

create table if not exists public.pms_change_watch (
  hotel_id uuid primary key references public.hotels(id) on delete cascade,
  change_days jsonb not null default '{}'::jsonb,
  other_tool_notice_at timestamptz,
  digest_sent_on date,
  updated_at timestamptz not null default now()
);

comment on table public.pms_change_watch is
  'Per property, for the scheduled syncs: change_days counts rates changed in the property system on nights MAYA '
  'sent to, per property date, over the last 7 days; other_tool_notice_at is the last warning that something '
  'other than MAYA seems to be changing rates; digest_sent_on is the property date of the last overwrite email.';

alter table public.pms_change_watch enable row level security;

revoke all on public.pms_change_watch from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.pms_change_watch to service_role;

-- ── 5. The Settings save ────────────────────────────────────────────────────

create or replace function public.set_pms_rate_changes(
  p_hotel_id uuid,
  p_mode text,
  p_replace boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current text;
  v_tz text;
  v_today date;
  v_now timestamptz := now();
  v_nights integer := 0;
  v_prices integer := 0;
  v_removed integer := 0;
begin
  if p_mode is null or p_mode not in ('keep', 'maya_wins') then
    raise exception 'pms_rate_changes must be keep or maya_wins' using errcode = '22023';
  end if;
  if not public.can_manage_hotel(p_hotel_id) then
    raise exception 'not allowed to change this property''s settings' using errcode = '42501';
  end if;

  select s.pms_rate_changes into v_current
    from public.hotel_settings s
   where s.hotel_id = p_hotel_id
   for update;
  if not found then
    return jsonb_build_object('saved', false, 'reason', 'no_row');
  end if;

  if p_mode = 'maya_wins' and v_current is distinct from 'maya_wins' then
    select h.timezone into v_tz from public.hotels h where h.id = p_hotel_id;
    begin
      v_today := (v_now at time zone coalesce(nullif(v_tz, ''), 'UTC'))::date;
    exception when others then
      v_today := (v_now at time zone 'UTC')::date;
    end;

    select count(distinct n.stay_date)::integer into v_nights
      from (
        select m.stay_date
          from public.manual_price m
         where m.hotel_id = p_hotel_id
           and m.source = 'pms'
           and m.cleared_at is null
           and m.stay_date >= v_today
        union all
        select b.stay_date
          from public.base_rate_calendar b
         where b.hotel_id = p_hotel_id
           and b.pms_removed_at is not null
           and b.stay_date >= v_today
      ) n;

    if v_nights > 0 and not coalesce(p_replace, false) then
      return jsonb_build_object('saved', false, 'reason', 'confirm', 'mode', v_current, 'nights', v_nights);
    end if;

    if v_nights > 0 then
      -- The rates changed in the PMS: cleared as Clear on the calendar does,
      -- and the rules they paused let go again.
      with cleared as (
        update public.manual_price m
           set cleared_at = v_now,
               cleared_by = auth.uid()
         where m.hotel_id = p_hotel_id
           and m.source = 'pms'
           and m.cleared_at is null
           and m.stay_date >= v_today
        returning m.room_type_id, m.stay_date
      ), lifted as (
        update public.ladder_rule_state s
           set suppressed_at = null
          from cleared c
         where s.rule_id in (select r.id from public.pricing_rules r where r.hotel_id = p_hotel_id)
           and s.room_type_id = c.room_type_id
           and s.stay_date = c.stay_date
           and s.suppressed_at is not null
        returning 1
      )
      select (select count(*) from cleared)::integer into v_prices;

      -- The rates removed in the PMS: MAYA prices those nights again, and
      -- their ledger rows say its price is not there, so the next run sends it.
      with handed_back as (
        update public.base_rate_calendar b
           set pms_removed_at = null
         where b.hotel_id = p_hotel_id
           and b.pms_removed_at is not null
           and b.stay_date >= v_today
        returning b.room_type_id, b.stay_date
      ), ledger as (
        update public.rate_updates u
           set status = 'skipped',
               error = 'rate removed in the PMS',
               sent_price = null
          from handed_back h
         where u.hotel_id = p_hotel_id
           and u.room_type_id = h.room_type_id
           and u.stay_date = h.stay_date
           and u.status = 'sent'
        returning 1
      )
      select (select count(*) from handed_back)::integer into v_removed;
    end if;
  end if;

  update public.hotel_settings
     set pms_rate_changes = p_mode,
         updated_at = v_now
   where hotel_id = p_hotel_id
     and pms_rate_changes is distinct from p_mode;

  return jsonb_build_object(
    'saved', true,
    'mode', p_mode,
    'nights', v_nights,
    'cleared_prices', v_prices,
    'handed_back', v_removed
  );
end;
$$;

revoke all on function public.set_pms_rate_changes(uuid, text, boolean) from public, anon;
grant execute on function public.set_pms_rate_changes(uuid, text, boolean) to authenticated, service_role;

commit;
