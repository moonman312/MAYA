-- MAYA PMS Request Log Retention v1 Migration
-- Global 7-day sweep for pms_request_log, replacing the opportunistic prune in
-- /api/pms/activity that only ever ran for hotels whose dashboard someone
-- opened. Nobody reads past 24h (health strip) or the latest 50 rows (activity
-- feed), so 7 days is the same policy that route already enforced — this just
-- makes it apply to every hotel, viewed or not. At fleet scale the difference
-- is unbounded growth: a synced-but-unwatched property writes ~20 rows per
-- 5-minute tick forever.
--
-- Run AFTER 02_supabase_schema.sql. Safe to re-run (idempotent guards).
-- Schedule via supabase/cron/pms-request-log-sweep.sql.example.

begin;

-- The existing index is (hotel_id, created_at) — right for the dashboard, no
-- help to a global cutoff scan. The sweep needs created_at on its own.
create index if not exists idx_pms_request_log_created
  on pms_request_log (created_at);

-- Batched so a day's worth of fleet traffic never becomes one long-held lock
-- on a table the sync workers are appending to. The iteration cap bounds a
-- single run; a backlog bigger than cap × batch just finishes tomorrow.
create or replace function public.pms_request_log_sweep(
  p_keep_days integer default 7,
  p_batch integer default 50000
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cutoff timestamptz := now() - make_interval(days => p_keep_days);
  removed integer := 0;
  batch_removed integer;
  passes integer := 0;
begin
  loop
    delete from pms_request_log
     where id in (
       select id from pms_request_log
        where created_at < cutoff
        order by created_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    removed := removed + batch_removed;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;
  return removed;
end;
$$;

revoke all on function public.pms_request_log_sweep(integer, integer) from public, anon, authenticated;
grant execute on function public.pms_request_log_sweep(integer, integer) to service_role;

commit;
