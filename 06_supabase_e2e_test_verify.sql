-- ============================================================================
-- 06_supabase_e2e_test_verify.sql — pass/fail checks for the E2E fixture
-- ============================================================================
-- Run in Supabase SQL Editor (service role — bypasses RLS) at three points:
--   * Section A  right after 05_supabase_e2e_test_seed.sql
--   * Section B  during/after the invite → accept flow
--   * Section C  after POST /api/evaluate (run it logged in as the test user)
-- Section D prints the IDs/dates you need for /api/pricing-debug calls.
--
-- All date math anchors on the SEED day (recovered as min(stay_date)+30), so
-- these checks stay correct even if you verify a day or two later. The exact
-- price expectations assume /api/evaluate ran the SAME day as the seed.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION A — seed integrity (expect pass = true on every row)
-- ────────────────────────────────────────────────────────────────────────────
with h as (
  select id from public.hotels where name = 'MAYA E2E Test Hotel'
), seed as (
  select (select min(stay_date) + 30 from public.reservations where hotel_id = (select id from h)) as day0
)
select * from (
  select 1 as ord, 'hotel exists (tz Europe/Istanbul, active)' as check,
    exists(select 1 from public.hotels
           where id = (select id from h) and timezone = 'Europe/Istanbul' and is_active) as pass
  union all
  select 2, 'hotel_settings row present',
    exists(select 1 from public.hotel_settings where hotel_id = (select id from h))
  union all
  select 3, '4 active room types (STD/DLX/STE/BGT)',
    (select count(*) from public.room_types
     where hotel_id = (select id from h) and is_active
       and external_room_type_id in ('STD','DLX','STE','BGT')) = 4
  union all
  select 4, 'Budget band is 95..120 (clamp fixture)',
    exists(select 1 from public.room_types
           where hotel_id = (select id from h) and external_room_type_id = 'BGT'
             and floor_price = 95.00 and ceiling_price = 120.00)
  union all
  select 5, 'reservations cover 151 distinct stay dates',
    (select count(distinct stay_date) from public.reservations
     where hotel_id = (select id from h)) = 151
  union all
  select 6, 'compression week ~90% (day0+8: 36+27+14+18 = 95 booked)',
    (select count(*) from public.reservations
     where hotel_id = (select id from h)
       and stay_date = (select day0 + 8 from seed)) = 95
  union all
  select 7, 'soft period ~30% (day0+50: 12+9+5+6 = 32 booked)',
    (select count(*) from public.reservations
     where hotel_id = (select id from h)
       and stay_date = (select day0 + 50 from seed)) = 32
  union all
  select 8, '7 rules seeded, 6 active',
    (select count(*) from public.pricing_rules where hotel_id = (select id from h)) = 7
    and (select count(*) from public.pricing_rules
         where hotel_id = (select id from h) and is_active) = 6
  union all
  select 9, 'every rule has a condition row (CHECK-valid)',
    (select count(*) from public.rule_condition rc
     join public.pricing_rules pr on pr.id = rc.rule_id
     where pr.hotel_id = (select id from h)) = 7
  union all
  select 10, 'pickup flags synced by trigger (exactly 2 pickup rules)',
    (select count(*) from public.pricing_rules
     where hotel_id = (select id from h) and is_pickup_rule) = 2
  union all
  select 11, 'baseline snapshots: 30 stay dates × 4 room types, ~73h old',
    (select count(*) from public.stay_date_snapshot
     where hotel_id = (select id from h)
       and snapshot_ts < now() - interval '71 hours') = 120
  union all
  select 12, 'no engine output yet (published_price empty until evaluate)',
    not exists(select 1 from public.published_price where hotel_id = (select id from h))
) checks order by ord;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION B — invite lifecycle state (run before AND after acceptance)
-- ────────────────────────────────────────────────────────────────────────────
-- Before acceptance expect: pending row status='pending', no auth user,
-- no membership. After accepting expect: status='accepted' with accepted_at
-- set, auth user + profiles row exist, membership hotel_admin/active.
select 'pending_invite' as what, pm.email::text, pm.role::text, pm.status::text,
       pm.invited_at, pm.accepted_at
from public.pending_memberships pm
where pm.hotel_id = (select id from public.hotels where name = 'MAYA E2E Test Hotel')

union all
select 'auth_user', u.email, '-', case when u.email_confirmed_at is null
       then 'unconfirmed' else 'confirmed' end, u.created_at, u.email_confirmed_at
from auth.users u
where lower(u.email) = 'scdeloach16+mayatest@gmail.com'

union all
select 'membership', u.email, hm.role::text, hm.status::text, hm.created_at, null
from public.hotel_memberships hm
join auth.users u on u.id = hm.user_id
where hm.hotel_id = (select id from public.hotels where name = 'MAYA E2E Test Hotel');

-- RLS scoping: the test user must have exactly ONE membership, and it must
-- be this hotel (they must NOT see The Grand Marina / Skyline / Harbor View).
select u.email, count(*) as memberships,
       bool_and(h.name = 'MAYA E2E Test Hotel') as only_e2e_hotel
from public.hotel_memberships hm
join auth.users u on u.id = hm.user_id
join public.hotels h on h.id = hm.hotel_id
where lower(u.email) = 'scdeloach16+mayatest@gmail.com'
group by u.email;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION C — post-evaluate checks (expect pass = true on every row)
-- ────────────────────────────────────────────────────────────────────────────
-- Price expectations (evaluate run same day as seed, pickup baselines fresh):
--   STD day0+8  : 175 ×1.10 (High Occ) ×1.05 (Pickup)      = 202.13
--   STE day0+8  : 395 ×1.10 + $50 (Suite Pickup wins)      = 484.50
--   BGT day0+8  : 110 ×1.10 ×1.25 ×1.05 = 158.81 → ceiling = 120.00
--   STD day0+50 : 175 ×0.95 (Early Bird)                   = 166.25
--   STD quiet Sun-Tue in day0+30..44 (no rules, no baseline)= 175.00
-- If pickup was blocked (evaluate ran >11h after seed) the ×1.05 / +$50
-- terms vanish; the checks below accept both values but flag it in check 24.
with h as (
  select id from public.hotels where name = 'MAYA E2E Test Hotel'
), seed as (
  select (select min(stay_date) + 30 from public.reservations where hotel_id = (select id from h)) as day0
), rts as (
  select external_room_type_id as code, id from public.room_types
  where hotel_id = (select id from h)
), quiet_day as (
  -- first Sun/Mon/Tue between day0+30 and day0+44 (outside every rule window)
  select min(d)::date as d from (
    select (select day0 from seed) + o as d from generate_series(30, 44) o
  ) x where extract(isodow from d) in (7, 1, 2)
), px as (
  select r.code, p.stay_date, p.price
  from public.published_price p join rts r on r.id = p.room_type_id
  where p.hotel_id = (select id from h)
)
select * from (
  select 20 as ord, 'published_price rows exist (≈484: 121 days × 4 types)' as check,
    (select count(*) from px) between 400 and 600 as pass
  union all
  select 21, 'STD compression day = 202.13 (or 192.50 if pickup blocked)',
    exists(select 1 from px where code = 'STD' and stay_date = (select day0 + 8 from seed)
           and (abs(price - 202.13) <= 0.05 or abs(price - 192.50) <= 0.05))
  union all
  select 22, 'STE compression day = 484.50 (or 434.50 if pickup blocked)',
    exists(select 1 from px where code = 'STE' and stay_date = (select day0 + 8 from seed)
           and (abs(price - 484.50) <= 0.05 or abs(price - 434.50) <= 0.05))
  union all
  select 23, 'BGT compression day clamped at 120.00 ceiling',
    exists(select 1 from px where code = 'BGT' and stay_date = (select day0 + 8 from seed)
           and price = 120.00)
  union all
  select 24, 'pickup events actually fired (if false: baselines went stale — reseed §6 + re-evaluate)',
    exists(select 1 from public.pickup_event
           where hotel_id = (select id from h) and retired_at is null)
  union all
  select 25, 'Suite Pickup Surge beat Property Pickup Bump on Suites',
    not exists(
      select 1 from public.pickup_event pe
      join public.pricing_rules pr on pr.id = pe.rule_id
      where pe.hotel_id = (select id from h)
        and pe.affected_room_type_id = (select id from rts where code = 'STE')
        and pe.retired_at is null
        and pr.name <> 'Suite Pickup Surge')
    and exists(
      select 1 from public.pickup_event pe
      join public.pricing_rules pr on pr.id = pe.rule_id
      where pe.hotel_id = (select id from h)
        and pe.affected_room_type_id = (select id from rts where code = 'STE')
        and pe.retired_at is null
        and pr.name = 'Suite Pickup Surge')
  union all
  select 26, 'STD soft-period day = 166.25 (Early Bird −5%)',
    exists(select 1 from px where code = 'STD' and stay_date = (select day0 + 50 from seed)
           and abs(price - 166.25) <= 0.05)
  union all
  select 27, 'quiet Sun-Tue day publishes plain base 175.00',
    exists(select 1 from px where code = 'STD' and stay_date = (select d from quiet_day)
           and price = 175.00)
  union all
  select 28, 'High Occupancy Surge ladder ACTIVE on compression day (4 room types)',
    (select count(*) from public.ladder_rule_state ls
     join public.pricing_rules pr on pr.id = ls.rule_id
     where pr.hotel_id = (select id from h) and pr.name = 'High Occupancy Surge'
       and ls.stay_date = (select day0 + 8 from seed) and ls.is_active) = 4
  union all
  select 29, 'High Occupancy Surge ladder INACTIVE on soft-period day',
    not exists(select 1 from public.ladder_rule_state ls
     join public.pricing_rules pr on pr.id = ls.rule_id
     where pr.hotel_id = (select id from h) and pr.name = 'High Occupancy Surge'
       and ls.stay_date = (select day0 + 50 from seed) and ls.is_active)
  union all
  select 30, 'audit trail: BGT compression day recorded clamped_by=ceiling',
    exists(select 1 from public.evaluation_audit ea
           where ea.hotel_id = (select id from h)
             and ea.stay_date = (select day0 + 8 from seed)
             and ea.room_type_id = (select id from rts where code = 'BGT')
             and ea.details ->> 'clamped_by' = 'ceiling'
             and ea.final_price = 120.00)
  union all
  select 31, 'audit rows carry the pre-clamp math (pre_clamp > final for BGT)',
    exists(select 1 from public.evaluation_audit ea
           where ea.hotel_id = (select id from h)
             and ea.stay_date = (select day0 + 8 from seed)
             and ea.room_type_id = (select id from rts where code = 'BGT')
             and ea.pre_clamp_price > ea.final_price)
) checks order by ord;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION D — handy IDs & dates for /api/pricing-debug and spot checks
-- ────────────────────────────────────────────────────────────────────────────
-- Plug into (logged in as the test user, from the browser console):
--   await fetch(`/api/pricing-debug?hotel_id=${HID}&stay_date=${DATE}&room_type_id=${RTID}`)
--     .then(r => r.json())
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel'),
seed as (select (select min(stay_date) + 30 from public.reservations
                 where hotel_id = (select id from h)) as day0)
select 'hotel_id' as key, (select id from h)::text as value
union all
select 'room_type_id ' || external_room_type_id, id::text
  from public.room_types where hotel_id = (select id from h)
union all
select 'compression date (day0+8)', (select day0 + 8 from seed)::text
union all
select 'soft-period date (day0+50)', (select day0 + 50 from seed)::text
union all
select 'last-minute date (day0+1)', (select day0 + 1 from seed)::text;
