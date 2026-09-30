-- ============================================================================
-- MAYA: the Settings area's calendar and display choices, v1
-- ============================================================================
--
-- Decided by Jake on 2026-09-30. The dashboard gets one Settings area:
--
--   1. hotel_settings, for the whole property:
--        calendar_big_metric          the big number on each calendar day
--        calendar_small_metric_1      the first small line under it (null: none)
--        calendar_small_metric_2      the second small line (null: none)
--        calendar_price_room_type_id  the room type "Price for" shows (null: none picked)
--        calendar_colors              'standard', or 'reversed' (green marks the
--                                     weak nights and red the strong ones)
--      The metrics are 'occupancy' (sellable occupancy), 'rooms_booked'
--      (booked over rooms you can sell), 'room_revenue', 'adr', 'revpar' and
--      'price' (MAYA's published price for calendar_price_room_type_id).
--      Every default is the calendar as it was: occupancy, then rooms booked,
--      then room revenue, in the standard colours. A property that never
--      opens Settings sees exactly what it saw before.
--   2. profiles.text_size, for each person: 'standard', 'large' or 'larger'.
--      The app mirrors it in a cookie so a page opens at the right size.
--
-- No policy or grant changes. hotel_settings keeps its row level security:
-- reading needs is_hotel_accessible(), writing needs can_manage_hotel()
-- (Revenue Manager and up, and a platform admin only in God Mode, whose
-- changes trg_god_mode_record_change already writes to the change log).
-- profiles_update already limits a person to their own row. No function is
-- created, so nothing new runs with the owner's rights.
--
-- The room type a price comes from is checked against the property by the
-- app; the foreign key only keeps it pointing at a room type that exists,
-- and a room type that goes away leaves "Price for" showing a dash.
--
-- Safe to run more than once: columns are added only when missing and every
-- check is dropped and made again. The app reads the new columns when they
-- are there and shows the calendar as it was when they are not, so deploy
-- order does not matter.
-- ============================================================================

begin;

-- ── 1. The property's calendar ──────────────────────────────────────────────

alter table public.hotel_settings
  add column if not exists calendar_big_metric text not null default 'occupancy',
  add column if not exists calendar_small_metric_1 text default 'rooms_booked',
  add column if not exists calendar_small_metric_2 text default 'room_revenue',
  add column if not exists calendar_price_room_type_id uuid
    references public.room_types(id) on delete set null,
  add column if not exists calendar_colors text not null default 'standard';

alter table public.hotel_settings drop constraint if exists hotel_settings_calendar_big_metric_check;
alter table public.hotel_settings add constraint hotel_settings_calendar_big_metric_check
  check (calendar_big_metric in ('occupancy', 'rooms_booked', 'room_revenue', 'adr', 'revpar', 'price'));

alter table public.hotel_settings drop constraint if exists hotel_settings_calendar_small_metric_1_check;
alter table public.hotel_settings add constraint hotel_settings_calendar_small_metric_1_check
  check (calendar_small_metric_1 is null
         or calendar_small_metric_1 in ('occupancy', 'rooms_booked', 'room_revenue', 'adr', 'revpar', 'price'));

alter table public.hotel_settings drop constraint if exists hotel_settings_calendar_small_metric_2_check;
alter table public.hotel_settings add constraint hotel_settings_calendar_small_metric_2_check
  check (calendar_small_metric_2 is null
         or calendar_small_metric_2 in ('occupancy', 'rooms_booked', 'room_revenue', 'adr', 'revpar', 'price'));

-- Each number shows once, and a second small line needs a first.
alter table public.hotel_settings drop constraint if exists hotel_settings_calendar_metrics_check;
alter table public.hotel_settings add constraint hotel_settings_calendar_metrics_check
  check (calendar_small_metric_1 is distinct from calendar_big_metric
         and calendar_small_metric_2 is distinct from calendar_big_metric
         and (calendar_small_metric_2 is null
              or (calendar_small_metric_1 is not null
                  and calendar_small_metric_2 is distinct from calendar_small_metric_1)));

alter table public.hotel_settings drop constraint if exists hotel_settings_calendar_colors_check;
alter table public.hotel_settings add constraint hotel_settings_calendar_colors_check
  check (calendar_colors in ('standard', 'reversed'));

comment on column public.hotel_settings.calendar_big_metric is
  'The big number on each calendar day: occupancy, rooms_booked, room_revenue, adr, revpar or price. Default occupancy.';
comment on column public.hotel_settings.calendar_small_metric_1 is
  'The first small line on each calendar day, or null for none. Default rooms_booked.';
comment on column public.hotel_settings.calendar_small_metric_2 is
  'The second small line on each calendar day, or null for none. Default room_revenue.';
comment on column public.hotel_settings.calendar_price_room_type_id is
  'The room type whose published price the price metric shows. Null: none picked, the calendar shows a dash.';
comment on column public.hotel_settings.calendar_colors is
  'standard: green strong nights, red weak. reversed: green weak nights, red strong. Amber is typical in both.';

-- ── 2. Each person's text size ──────────────────────────────────────────────

alter table public.profiles
  add column if not exists text_size text not null default 'standard';

alter table public.profiles drop constraint if exists profiles_text_size_check;
alter table public.profiles add constraint profiles_text_size_check
  check (text_size in ('standard', 'large', 'larger'));

comment on column public.profiles.text_size is
  'How large MAYA shows text for this person: standard, large or larger. Mirrored in the maya-text-size cookie.';

commit;
