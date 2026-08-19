-- ============================================================================
-- ENGINE OPS v1 — evaluation_audit indexes + spam prune
-- Run in Supabase Dashboard → SQL Editor. Idempotent.
--
-- Why: earlier engine generations wrote an evaluation_audit row for EVERY
-- cell on EVERY 5-minute tick, whether or not anything changed. On a hotel
-- that has run for weeks this is hundreds of thousands of identical rows,
-- and the change-detection query that reads newest-first started hitting the
-- statement timeout. The current engine only writes on change; this cleans
-- up what the old one left behind and makes sure the reads are indexed.
-- ============================================================================

-- 1) The two indexes the changelog and signature reads depend on. Present in
--    02_supabase_schema.sql for fresh installs; older live databases predate
--    them.
create index if not exists idx_evaluation_audit_hotel_evaluated
  on evaluation_audit(hotel_id, evaluated_at desc);

create index if not exists idx_evaluation_audit_cell
  on evaluation_audit(hotel_id, stay_date, room_type_id, evaluated_at desc);

-- 2) Prune consecutive-duplicate audit spam: keep every row that DIFFERS from
--    the previous row for its cell (a real change), plus each cell's newest
--    row (the signature the engine compares against). Delete the identical
--    repeats in between. Uses final_price + details as the change signature,
--    mirroring the engine's own auditSignature comparison.
with ranked as (
  select
    id,
    row_number() over (
      partition by hotel_id, stay_date, room_type_id
      order by evaluated_at desc
    ) as rn_desc,
    final_price,
    lag(final_price) over (
      partition by hotel_id, stay_date, room_type_id
      order by evaluated_at asc
    ) as prev_price,
    details,
    lag(details) over (
      partition by hotel_id, stay_date, room_type_id
      order by evaluated_at asc
    ) as prev_details
  from evaluation_audit
)
delete from evaluation_audit ea
using ranked r
where ea.id = r.id
  and r.rn_desc > 1                       -- never the newest row per cell
  and r.prev_price is not null            -- never a cell's first row
  and r.final_price = r.prev_price
  and r.details = r.prev_details;

-- Reclaim the space (safe to skip; autovacuum gets there eventually):
-- vacuum (analyze) evaluation_audit;
