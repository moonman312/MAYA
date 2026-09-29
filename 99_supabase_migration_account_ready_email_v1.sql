-- ============================================================================
-- ACCOUNT READY EMAIL: sent once per property, and never twice
-- ============================================================================
--
-- The "Payment received" screen tells an owner who leaves it that we will email
-- them when their account is ready. The Stripe webhook sends that email the
-- first time a property's subscription is live (trialing or active), from
-- lib/billing/account-ready.ts.
--
-- Stripe delivers every event at least once, often several at a time
-- (customer.subscription.created, checkout.session.completed and
-- customer.subscription.updated can land in the same second), and retries for
-- days. "Once" therefore has to be a fact in the database rather than a hope
-- in the code: the webhook claims hotel_subscriptions.account_ready_emailed_at
-- with
--
--   update hotel_subscriptions set account_ready_emailed_at = now()
--    where hotel_id = $1 and account_ready_emailed_at is null
--   returning hotel_id
--
-- and only the delivery that gets a row back sends. A send that fails puts the
-- column back to null (only if it still holds that delivery's own stamp), so a
-- later delivery can try again; Resend's idempotency key covers the case where
-- the first attempt did get through.
--
-- The row is keyed by hotel and reused when a property subscribes again, so
-- the stamp is per property: a property gets this email once, ever.
--
-- BACKFILL. Every property that already has a subscription row signed up
-- before this email existed, and the next webhook for a customer of two years
-- must not welcome them. So the run that ADDS the column also stamps every
-- existing row with the time of the migration. It happens only on that run: a
-- second run finds the column there and changes nothing, so it can never
-- swallow the email of someone who paid in between.
--
-- RLS and grants are unchanged. The column sits on hotel_subscriptions, whose
-- read policy and revoked writes (99_supabase_migration_billing_v1.sql) already
-- cover it: members read it, only the service role writes it.
--
-- Run AFTER 99_supabase_migration_billing_v1.sql. Idempotent.
--
-- Deploy order: either. Code first: the claim names a column that is not there
-- yet, the webhook logs a warning naming this file, sends nothing and answers
-- Stripe 200 as before. This file first: the column is there and nothing
-- writes it until the code lands.
--
-- hotel_subscriptions is not in 01/02_supabase_schema.sql (the billing
-- migrations create it), so there is nothing to mirror there.

begin;

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'hotel_subscriptions'
       and column_name = 'account_ready_emailed_at'
  ) then
    alter table public.hotel_subscriptions
      add column account_ready_emailed_at timestamptz;

    update public.hotel_subscriptions
       set account_ready_emailed_at = now();
  end if;
end $$;

comment on column public.hotel_subscriptions.account_ready_emailed_at is
  'When the "your account is ready" email was claimed for this property, by the Stripe webhook the first time its '
  'subscription was live. Null means not sent yet. Rows that existed before 99_supabase_migration_account_ready_email_v1.sql '
  'were stamped with the migration time so they are never sent one.';

commit;

-- Check afterwards:
--
--   select count(*) as subscriptions, count(account_ready_emailed_at) as stamped
--     from hotel_subscriptions;
