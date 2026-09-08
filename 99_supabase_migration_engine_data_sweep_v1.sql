-- MAYA Engine Data Sweep v1 Migration
-- The engine's own retention (snapshot/audit/run-log purges) runs at the end
-- of evaluateHotel, and evaluateHotel only runs for entitled hotels — so a
-- churned or paused property's rows sit forever, growing nothing but storage
-- cost. This sweep is the backstop: same tables, same windows, every hotel,
-- regardless of whether anything still prices it.
--
-- The in-code purges stay: they keep live hotels trimmed to the tighter
-- dynamic snapshot window tick by tick. The sweep uses the code's own
-- conservative defaults, so for an entitled hotel it deletes what the next
-- evaluation would have deleted anyway.
--
-- Run AFTER 99_supabase_migration_run_heartbeat_v1.sql. Idempotent.
-- Schedule via supabase/cron/engine-data-sweep.sql.example.

begin;

-- The purges filter per hotel and lean on (hotel_id, ...) indexes; a global
-- cutoff scan needs the time columns on their own.
create index if not exists idx_stay_date_snapshot_ts
  on stay_date_snapshot (snapshot_ts);
create index if not exists idx_evaluation_audit_evaluated
  on evaluation_audit (evaluated_at);
create index if not exists idx_evaluation_run_log_evaluated
  on evaluation_run_log (evaluated_at);

-- Batched like pms_request_log_sweep: a backlog never becomes one long-held
-- lock, and anything bigger than cap × batch finishes tomorrow.
create or replace function public.engine_data_sweep(
  p_snapshot_days integer default 60,
  p_audit_days integer default 90,
  p_run_log_days integer default 90,
  p_batch integer default 50000
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer := 0;
  batch_removed integer;
  passes integer;
begin
  -- No surrogate key on the snapshot grid, so the batch is addressed by ctid —
  -- safe here because the subquery and delete run in one statement.
  passes := 0;
  loop
    delete from stay_date_snapshot
     where ctid in (
       select ctid from stay_date_snapshot
        where snapshot_ts < now() - make_interval(days => p_snapshot_days)
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    removed := removed + batch_removed;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  passes := 0;
  loop
    delete from evaluation_audit
     where id in (
       select id from evaluation_audit
        where evaluated_at < now() - make_interval(days => p_audit_days)
        order by evaluated_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    removed := removed + batch_removed;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  passes := 0;
  loop
    delete from evaluation_run_log
     where id in (
       select id from evaluation_run_log
        where evaluated_at < now() - make_interval(days => p_run_log_days)
        order by evaluated_at
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

revoke all on function public.engine_data_sweep(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.engine_data_sweep(integer, integer, integer, integer) to service_role;

commit;
