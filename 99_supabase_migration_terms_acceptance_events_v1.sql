-- ============================================================================
-- TERMS ACCEPTANCE IN THE PRODUCT EVENT LOG
-- ============================================================================
--
-- Every row written to terms_acceptances becomes an account.terms_accepted
-- event, so the funnel can show where people agree (signup, claim, invite or
-- the one-time accept screen) and how long existing users take to accept a new
-- version. The IP address and user agent stay in terms_acceptances: only the
-- versions, the context and where the row came from cross over.
--
-- The event's dedupe_key is the acceptance row's id, so the backfill at the
-- bottom and the trigger can never record the same acceptance twice, and
-- running this file again changes nothing.
--
-- Run after 99_supabase_migration_product_events_v1.sql and
-- 99_supabase_migration_terms_acceptance_v1.sql. No application deploy is
-- needed.

begin;

create or replace function public.product_events_terms_acceptances()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform public.product_event_emit(
      'account.terms_accepted', new.hotel_id, new.user_id,
      jsonb_build_object(
        'terms_version', new.terms_version,
        'privacy_version', new.privacy_version,
        'context', new.context,
        'acceptance_source', new.source),
      'trigger', new.accepted_at,
      'terms_acceptance:' || new.id::text
    );
  exception when others then
    raise warning 'product_events_terms_acceptances: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_terms_acceptances on public.terms_acceptances;
create trigger trg_product_events_terms_acceptances
  after insert on public.terms_acceptances
  for each row execute function public.product_events_terms_acceptances();

-- Anything accepted before this file ran.
select public.product_event_emit(
         'account.terms_accepted', ta.hotel_id, ta.user_id,
         jsonb_build_object(
           'terms_version', ta.terms_version,
           'privacy_version', ta.privacy_version,
           'context', ta.context,
           'acceptance_source', ta.source),
         'backfill', ta.accepted_at,
         'terms_acceptance:' || ta.id::text)
  from public.terms_acceptances ta;

commit;

-- Check afterwards (the two counts should match):
--
--   select (select count(*) from terms_acceptances) as acceptances,
--          (select count(*) from product_events where event = 'account.terms_accepted') as events;
