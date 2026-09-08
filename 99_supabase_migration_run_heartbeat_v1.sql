-- One tiny row per evaluation run, so the Change Log's "Show All Cycles"
-- toggle can still prove the engine is checking every 5 minutes even on
-- runs where nothing moved — without paying for a full evaluation_audit row
-- per priced cell just to say "nothing changed".
--
-- evaluation_audit now only writes when a cell's price or applied rules
-- actually differ from last time (see the write-on-change migration this
-- one follows). That fixed the storage blowup, but it also means a
-- completely quiet run leaves no trace anywhere — the Change Log can no
-- longer show "checked at 4:32, nothing needed to change" for it, only
-- silence. This table is the fix: one row per run, no JSONB, no per-cell
-- detail, just a timestamp and two counts. The narrative text itself is
-- never stored — it's rendered from these numbers at read time.

create table if not exists evaluation_run_log (
  id                 uuid primary key default gen_random_uuid(),
  hotel_id           uuid not null references hotels(id) on delete cascade,
  evaluation_run_id  uuid not null,
  evaluated_at       timestamptz not null,
  cells_checked      integer not null default 0,
  cells_changed      integer not null default 0,
  unique (hotel_id, evaluation_run_id)
);

create index if not exists idx_evaluation_run_log_hotel
  on evaluation_run_log(hotel_id, evaluated_at desc);

alter table evaluation_run_log enable row level security;

-- Same split-per-command shape as evaluation_audit: every member reads,
-- revenue_manager and up writes (matches who may trigger /api/evaluate).
drop policy if exists evaluation_run_log_read on evaluation_run_log;
create policy evaluation_run_log_read on evaluation_run_log
  for select using (is_hotel_accessible(hotel_id));
drop policy if exists evaluation_run_log_insert on evaluation_run_log;
create policy evaluation_run_log_insert on evaluation_run_log
  for insert with check (can_manage_hotel(hotel_id));
drop policy if exists evaluation_run_log_update on evaluation_run_log;
create policy evaluation_run_log_update on evaluation_run_log
  for update using (can_manage_hotel(hotel_id))
  with check (can_manage_hotel(hotel_id));
drop policy if exists evaluation_run_log_delete on evaluation_run_log;
create policy evaluation_run_log_delete on evaluation_run_log
  for delete using (can_manage_hotel(hotel_id));
