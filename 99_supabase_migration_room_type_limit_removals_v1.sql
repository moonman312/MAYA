-- ============================================================================
-- MAYA: a floor or ceiling the owner removes stays removed, v1
-- ============================================================================
--
-- Audit A21 follow-up (Jake, 2026-09-30: limits from the first import, each
-- with a one-click remove on the review).
--
-- The review's x puts a floor back to 1.00 or a ceiling back to 99,999.99,
-- which are exactly the values the import reads as "never set". The review
-- opens while the import is still reading older years, and the import's last
-- pass filled every limit still at those values again: the owner's remove
-- came back, sometimes as a different number than the one they removed. A
-- later import in simulation did the same, and also put the five-questions
-- floor back on.
--
-- What this file adds: two timestamps on room_types, stamped by the remove
-- (POST /api/room-types/limits) when it clears that limit.
--
--   floor_cleared_at    the owner removed this room type's floor
--   ceiling_cleared_at  the owner removed this room type's ceiling
--
-- An import (supabase/functions/_shared/onboarding/analysis.ts) never fills a
-- limit whose stamp is set, from the rates or from the answers. The owner's
-- own acts still set one: answering the floor or ceiling question again, a
-- suggestion card, or PIE's price limits. A stamp on a limit that has since
-- been set again changes nothing: the import only ever fills a limit at its
-- "never set" value.
--
-- Nothing else changes. room_types keeps its row security and its grants;
-- the new columns follow the table's (members read, a Revenue Manager or
-- higher writes, as for the limits themselves).
--
-- Run after 99_supabase_migration_pms_property_changes_v1.sql. One
-- transaction. Idempotent: safe to run twice. The app and the import work
-- before it (they read no stamp, and the remove saves without one), so run
-- it, then deploy.
-- ============================================================================

begin;

alter table public.room_types
  add column if not exists floor_cleared_at timestamptz;

alter table public.room_types
  add column if not exists ceiling_cleared_at timestamptz;

comment on column public.room_types.floor_cleared_at is
  'When the owner removed this room type''s floor (the review''s remove). An import never fills a floor that has this set, from the rates or the answers.';

comment on column public.room_types.ceiling_cleared_at is
  'When the owner removed this room type''s ceiling (the review''s remove). An import never fills a ceiling that has this set, from the rates or the answers.';

commit;

-- After running, expect two rows:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'room_types'
--      and column_name in ('floor_cleared_at', 'ceiling_cleared_at');
