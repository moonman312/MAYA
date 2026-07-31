-- Every property is on a plan, including ours.
--
-- Until now "no hotel_subscriptions row" was a normal, expected state — the
-- sandbox, anything an admin created by hand, every deployment without Stripe.
-- Two pieces of code already had to special-case it (splitByEntitlement lets it
-- through, loadTeam skips the seat limit), and each of those is a place where the
-- absence of billing has to be told apart from lapsed billing by inference.
--
-- Jake's call: give internal properties a real, explicit plan instead. A missing
-- row then means something is wrong rather than something is internal, which is
-- a far more useful thing for a monitor to be able to say.
--
-- Run any time. Idempotent. Backfills every existing hotel.

alter table hotel_subscriptions
  add column if not exists plan_kind text not null default 'stripe'
    check (plan_kind in ('stripe', 'internal'));

comment on column hotel_subscriptions.plan_kind is
  'stripe = a real paying subscription. internal = ours: sandbox, demo, staff. Entitled and seat-limited like any other plan, but never charged and never swept for card checks.';

-- Stripe ids are meaningless on an internal plan, and requiring a fake one would
-- mean inventing a customer that does not exist in Stripe.
alter table hotel_subscriptions
  alter column stripe_customer_id drop not null;

-- Belt and braces on the thing that would actually hurt: a row that claims to be
-- a Stripe plan with nothing to bill against.
alter table hotel_subscriptions
  drop constraint if exists hotel_subscriptions_stripe_needs_customer;
alter table hotel_subscriptions
  add constraint hotel_subscriptions_stripe_needs_customer
  check (plan_kind <> 'stripe' or stripe_customer_id is not null);

create index if not exists idx_hotel_subscriptions_plan_kind
  on hotel_subscriptions(plan_kind)
  where plan_kind = 'internal';

/* ── Backfill: every hotel that has no plan gets the internal one ─────────── */
--
-- billed_rooms has a `> 0` check and drives the seat allowance, so it is set
-- from the property's actual room types where those exist. A hotel mid-import
-- has none yet; 1 room is the honest placeholder, and the seat band for it is
-- the smallest, which is correct for a property nobody has set up.

insert into hotel_subscriptions (
  hotel_id, stripe_customer_id, stripe_subscription_id, status,
  billing_interval, billed_rooms, plan_kind
)
select
  h.id,
  null,
  null,
  -- 'active' rather than a private word: isEntitledStatus already treats it as
  -- entitled, so nothing downstream needs to learn a new status to keep working.
  'active',
  'month',
  greatest(1, coalesce((
    select sum(rt.total_rooms)
      from room_types rt
     where rt.hotel_id = h.id
       and rt.is_active
  ), 0)),
  'internal'
from hotels h
where not exists (select 1 from hotel_subscriptions s where s.hotel_id = h.id)
on conflict (hotel_id) do nothing;

/* ── Keep the card-check sweeps off internal plans ────────────────────────── */
--
-- They have no card, so a due date on one would be swept forever and never
-- settle. The index the sweep uses is narrowed rather than the query, so this
-- holds even if a future caller forgets.

drop index if exists idx_hotel_subscriptions_card_due;
create index if not exists idx_hotel_subscriptions_card_due
  on hotel_subscriptions(card_verify_due_at)
  where card_rechecked_at is null
    and card_verify_failed_at is null
    and plan_kind = 'stripe';

update hotel_subscriptions
   set card_verify_due_at = null
 where plan_kind = 'internal'
   and card_verify_due_at is not null;
