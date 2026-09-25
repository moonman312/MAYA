-- A room type can have no rooms.
--
-- room_types.total_rooms was created with check (total_rooms > 0). Counts now
-- come from the PMS's own room list (Think: GET /rooms), and a type whose
-- rooms are all inactive, or that has none, counts 0. Until this runs, the
-- syncs keep such a type's stored count and log a line naming this file.
--
-- Run any time. Idempotent.

begin;

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'room_types'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%total_rooms > 0%'
  loop
    execute format('alter table public.room_types drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.room_types
  drop constraint if exists room_types_total_rooms_check;
alter table public.room_types
  add constraint room_types_total_rooms_check check (total_rooms >= 0);

commit;

-- Check: one row, definition CHECK ((total_rooms >= 0)).
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.room_types'::regclass and contype = 'c'
--   and pg_get_constraintdef(oid) ilike '%total_rooms%';
