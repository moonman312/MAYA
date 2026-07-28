-- MAYA Realtime v1 Migration
-- Adds published_price and reservations to the `supabase_realtime` publication
-- so the dashboard calendar refreshes live when the pricing engine writes new
-- prices or a PMS sync lands reservations (see src/lib/use-calendar-live.ts).
--
-- Run AFTER 02_supabase_schema.sql. Safe to re-run (guards against duplicate
-- publication membership).
--
-- NOT mirrored into 02_supabase_schema.sql: publication membership is Realtime
-- wiring, not table structure, and isn't part of the schema dump pattern.
-- Nothing added to 00_supabase_reset_dev.sql either — dropping a table
-- automatically removes it from any publication.

do $$
begin
  -- Supabase provisions this publication by default; recreate it (empty) if a
  -- reset ever removed it.
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'published_price'
  ) then
    alter publication supabase_realtime add table public.published_price;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reservations'
  ) then
    alter publication supabase_realtime add table public.reservations;
  end if;
end
$$;
