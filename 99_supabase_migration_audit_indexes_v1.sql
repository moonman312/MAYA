-- evaluation_audit had no indexes at all despite every read pattern filtering
-- on hotel_id and ordering by evaluated_at — the changelog route and the new
-- per-cell "last audit signature" lookup were both full table scans. Cheap
-- to add, and it matters more now that write-on-change means the table is
-- read far more often relative to its (much smaller) size.

create index if not exists idx_evaluation_audit_hotel_evaluated
  on evaluation_audit(hotel_id, evaluated_at desc);

create index if not exists idx_evaluation_audit_cell
  on evaluation_audit(hotel_id, stay_date, room_type_id, evaluated_at desc);
