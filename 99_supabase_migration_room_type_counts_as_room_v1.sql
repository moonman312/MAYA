-- ============================================================================
-- COUNTS AS ROOM — one flag on room_types that says whether the thing is a
-- bedroom or a bookable something-else
-- ============================================================================
--
-- Every PMS models a pickleball court, a parking bay, a boardroom and a spa
-- slot as a "room type", because sellable inventory is the only primitive it
-- has. Until now MAYA told them apart three different ways in three different
-- places: a name heuristic at bill time, the same heuristic proposing an
-- onboarding finding, and is_active = false once an owner confirmed one. That
-- last one was a lie of convenience — is_active is meant to be the PMS's own
-- notion of active, and repurposing it meant a court the owner excluded also
-- vanished from things that had nothing to do with room counting.
--
-- So: counts_as_room. Three states on purpose.
--
--   null  = not yet classified. The import proposes a default from the name
--           heuristic with a `where counts_as_room is null` pass right after
--           the upsert, which is what makes it a PROPOSAL: the sync can never
--           tell an insert from an update, so the only way the owner's later
--           choice survives the next five-minute tick is that the sync only
--           ever writes into null. Only the onboarding import proposes
--           `false`, and only for names that are never a bedroom (parking,
--           boardroom); the steady-state sync writes `true` at most and leaves
--           the rest null, because nobody is on a review screen to correct it.
--   false = not a room. Excluded from the occupancy denominator and numerator,
--           Booking Speed capacity, RevPAR, the default signal/affected sets
--           of NEW rules, the simulator seed, and — the reason this is audited
--           — the count MAYA bills for.
--   true  = a room, even if the name says "Pickleball Suite". The owner's word
--           beats the heuristic in both directions.
--
-- Readers treat `counts_as_room is distinct from false` as counted, so a row
-- the import has not classified yet behaves exactly as it did before this
-- migration.
--
-- counts_as_room_set_by says WHO decided: null is the import heuristic, a
-- user id is a person (the review strip, room-type settings, or a direct
-- write). Billing words the two differently — "we guessed" is not "you
-- marked" — and analysis only treats a type as answered when a person did.
--
-- Run AFTER 99_supabase_migration_manual_price_v1.sql. Idempotent. Code
-- deployed ahead of this file falls back to the name heuristic and logs that
-- it did so; nothing fails.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass, like manual_price.

begin;

alter table room_types
  add column if not exists counts_as_room boolean;

comment on column room_types.counts_as_room is
  'Whether this type is a sleeping room (true), a bookable non-room like a court or parking bay (false), or not yet classified (null). The import proposes a default from the name heuristic into null only; the owner confirms or overrides it on the onboarding review strip or in room-type settings. Readers count `is distinct from false`. Every owner change is written to platform_audit_events as room_type.classified, because false lowers the bill.';

alter table room_types
  add column if not exists counts_as_room_set_by uuid references auth.users(id) on delete set null;

comment on column room_types.counts_as_room_set_by is
  'Who set counts_as_room: null = the import heuristic, otherwise the user. The API routes stamp it; the trigger below stamps direct writes.';

-- The import's defaulting pass filters on null; on a hotel with a few hundred
-- types this keeps it from scanning the ones already decided.
create index if not exists idx_room_types_unclassified
  on room_types (hotel_id)
  where counts_as_room is null;

-- room_types keeps its member write grant (the PMS tab edits guardrails on
-- it), so a Revenue Manager can flip counts_as_room straight through
-- PostgREST and skip the API route that audits it and re-prices. The flag
-- lowers the bill, so that path has to leave the same paperwork. Service-role
-- writes are the routes' own (they log with the real actor in detail, since
-- auth.uid() is null for them) and the heuristic's (which must stay silent),
-- so those are left alone.
create or replace function public.room_types_audit_counts_as_room()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.counts_as_room is distinct from old.counts_as_room
     and auth.role() is distinct from 'service_role' then
    new.counts_as_room_set_by := coalesce(auth.uid(), new.counts_as_room_set_by);
    insert into public.platform_audit_events
      (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
    values (
      auth.uid(),
      'room_type.classified',
      'room_type',
      new.id::text,
      new.hotel_id,
      jsonb_build_object(
        'room_type_id', new.id,
        'name', coalesce(new.display_name, new.name, ''),
        'before', old.counts_as_room,
        'after', new.counts_as_room,
        'via', 'direct',
        'actor_user_id', auth.uid()
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists room_types_audit_counts_as_room on room_types;
create trigger room_types_audit_counts_as_room
  before update of counts_as_room on room_types
  for each row
  execute function public.room_types_audit_counts_as_room();

-- RevPAR's numerator. The denominator (calendar-store) already sums only the
-- counted types' total_rooms; without this the revenue from a court or a
-- parking bay would land on top of a bedroom-only room count and inflate the
-- number. Same signature, same security-invoker RLS behaviour — the join
-- against room_types is filtered by its own is_hotel_accessible policy, which
-- is the same predicate reservations already has.
--
-- A reservation whose room type was deleted (room_type_id set null) stays in:
-- there is no evidence it was not a room, and dropping revenue on a null join
-- would be the surprising direction.
create or replace function public.calendar_daily_revenue(p_hotel_id uuid)
returns table(stay_date date, revenue numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.stay_date, sum(coalesce(r.current_rate, 0))::numeric as revenue
  from reservations r
  left join room_types rt on rt.id = r.room_type_id
  where r.hotel_id = p_hotel_id
    and rt.counts_as_room is distinct from false
  group by r.stay_date
  order by r.stay_date;
$$;

grant execute on function public.calendar_daily_revenue(uuid) to authenticated;

commit;
