-- Two doors around billing that RLS was leaving open.
--
-- Run any time. Idempotent.

/* ── 1. Anyone signed in could create a live property ─────────────────────── */
--
-- hotels_insert was `with check (auth.uid() is not null)` — a signed-in user
-- could POST straight to /rest/v1/hotels and get a working property, and because
-- auto_hotel_creator_membership keys off auth.uid() (which IS set on a
-- user-scoped insert, unlike a service-role one) they were handed hotel_admin on
-- it too. That is the paywall bypassed without touching the app at all: no card,
-- no signup code, no subscription row. splitByEntitlement then treats a hotel
-- with no subscription as entitled — correctly, since that is what keeps the
-- sandbox and keyless deployments working — so it is served indefinitely.
--
-- Nothing legitimate needs this grant. Every real insert already runs as
-- service_role and bypasses RLS: provisionPendingHotel (checkout),
-- handleOnboardingConnect (adoption), and createHotel (the admin wizard, which
-- deliberately uses service_role so the auto-membership trigger stays quiet).
-- Platform admins keep a path for the same reason they have one everywhere else.

drop policy if exists hotels_insert on hotels;
create policy hotels_insert
  on hotels for insert
  with check (is_platform_admin());

/* ── 2. A hotel_admin could delete away a live subscription ───────────────── */
--
-- hotel_subscriptions.hotel_id is `on delete cascade`, so deleting the hotel
-- takes the only local record of a Stripe subscription with it. Stripe keeps
-- billing the card either way — the customer is charged for a property MAYA no
-- longer knows exists, and nothing is left to reconcile it against or to drive
-- a refund from.
--
-- Deleting a property is still theirs to do; it just has to go through
-- cancellation first, which is a thing they can do themselves in the billing
-- portal. Platform admins are exempt so support can still clean up test rows.

create or replace function public.hotel_has_live_subscription(p_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from hotel_subscriptions s
    where s.hotel_id = p_hotel_id
      -- Matches isEntitledStatus() in _shared/billing/entitlement.ts. past_due
      -- counts: Stripe is still retrying the card, so the subscription is very
      -- much alive and still capable of charging them.
      and s.status in ('trialing', 'active', 'past_due')
  );
$$;

revoke all on function public.hotel_has_live_subscription(uuid) from public, anon;
grant execute on function public.hotel_has_live_subscription(uuid) to authenticated, service_role;

drop policy if exists hotels_delete on hotels;
create policy hotels_delete
  on hotels for delete
  using (
    is_platform_admin()
    or (
      has_hotel_role(id, array['hotel_admin'])
      and not hotel_has_live_subscription(id)
    )
  );
