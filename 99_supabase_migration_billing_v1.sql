-- MAYA Billing v1 — subscriptions, signup codes, redemptions.
--
-- Stripe holds the money and the truth about it; these tables hold what MAYA
-- needs to answer without a round-trip ("is this hotel paid up?", "which code
-- did they use?") plus the two things Stripe cannot model for us: a code that
-- gates signup entirely, and the 48-hour card re-check.
--
-- Run AFTER 02_supabase_schema.sql. Idempotent.

/* ── Subscriptions ────────────────────────────────────────────────────────── */

create table if not exists hotel_subscriptions (
  hotel_id                uuid primary key references hotels(id) on delete cascade,
  stripe_customer_id      text not null,
  stripe_subscription_id  text unique,
  -- Stripe's own vocabulary verbatim (trialing, active, past_due, canceled,
  -- incomplete, incomplete_expired, unpaid, paused) rather than a private enum:
  -- the webhook copies what it is told, so a status Stripe adds later lands
  -- here intact instead of failing a check constraint mid-payment.
  status                  text not null,
  billing_interval        text not null check (billing_interval in ('month', 'year')),
  -- The quantity actually billed = rooms the owner stated at checkout. What the
  -- PMS import later measures lives in onboarding_states.payment_tier_rooms;
  -- a mismatch is a flag for a human, never a silent re-charge.
  billed_rooms            integer not null check (billed_rooms > 0),
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean not null default false,
  -- A trial card that authorizes today can be a virtual card cancelled tomorrow,
  -- so the card is checked at signup and again ~48h later. verified_at is only
  -- the signup-time stage and is not terminal (card_rechecked_at, added in
  -- 99_supabase_migration_card_reverify_v2_two_stage.sql, is); failed_at set is
  -- the state the dunning banner reads — on its own, with no verified_at filter.
  card_verify_due_at      timestamptz,
  card_verified_at        timestamptz,
  card_verify_failed_at   timestamptz,
  signup_code_id          uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_hotel_subscriptions_status
  on hotel_subscriptions(status);
-- Drives the re-verification sweep: due, not yet verified, not yet failed.
create index if not exists idx_hotel_subscriptions_card_due
  on hotel_subscriptions(card_verify_due_at)
  where card_verified_at is null and card_verify_failed_at is null;

/* ── Signup codes ─────────────────────────────────────────────────────────── */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'signup_code_kind') then
    create type signup_code_kind as enum ('trial', 'percent_off', 'fixed_price');
  end if;
end $$;

create table if not exists signup_codes (
  id                  uuid primary key default gen_random_uuid(),
  -- Compared case-insensitively (see uq_signup_codes_code): owners type these
  -- off a business card, and "DRIFTWOOD" losing to "driftwood" is a support
  -- ticket for a product whose whole point is never needing support.
  code                text not null,
  kind                signup_code_kind not null,
  -- trial
  trial_days          integer check (trial_days is null or trial_days > 0),
  -- percent_off; duration_months null = forever
  percent_off         numeric(5,2) check (percent_off is null or (percent_off > 0 and percent_off <= 100)),
  duration_months     integer check (duration_months is null or duration_months > 0),
  -- fixed_price: an agreed monthly/annual number, optionally pinned to a tier
  fixed_price_cents   integer check (fixed_price_cents is null or fixed_price_cents >= 0),
  fixed_price_interval text check (fixed_price_interval is null or fixed_price_interval in ('month', 'year')),
  tier_rooms_cap      integer check (tier_rooms_cap is null or tier_rooms_cap > 0),
  -- Limits. A code that leaks to a forum should cost a bounded amount.
  max_redemptions     integer check (max_redemptions is null or max_redemptions > 0),
  expires_at          timestamptz,
  is_active           boolean not null default true,
  -- Why this code exists and who got it. Doubles as sales attribution.
  notes               text,
  stripe_coupon_id    text,
  stripe_promotion_code_id text,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Each kind needs its own fields and nothing else's, or a half-filled code
  -- silently grants the wrong thing at checkout.
  constraint chk_signup_code_shape check (
    (kind = 'trial'       and trial_days is not null and percent_off is null and fixed_price_cents is null)
    or (kind = 'percent_off'  and percent_off is not null and trial_days is null and fixed_price_cents is null)
    or (kind = 'fixed_price'  and fixed_price_cents is not null and fixed_price_interval is not null and percent_off is null)
  )
);

create unique index if not exists uq_signup_codes_code on signup_codes(lower(code));

alter table hotel_subscriptions
  drop constraint if exists hotel_subscriptions_signup_code_id_fkey;
alter table hotel_subscriptions
  add constraint hotel_subscriptions_signup_code_id_fkey
  foreign key (signup_code_id) references signup_codes(id) on delete set null;

create table if not exists signup_code_redemptions (
  id            uuid primary key default gen_random_uuid(),
  code_id       uuid not null references signup_codes(id) on delete cascade,
  hotel_id      uuid references hotels(id) on delete set null,
  user_id       uuid references auth.users(id) on delete set null,
  -- Denormalized on purpose: Jake wants the redeeming admin's email in the
  -- code report, and it has to survive the user or hotel being deleted.
  email         text not null,
  redeemed_at   timestamptz not null default now()
);

-- One redemption per hotel per code — a retried checkout must not read as two.
create unique index if not exists uq_signup_code_redemptions_hotel
  on signup_code_redemptions(code_id, hotel_id)
  where hotel_id is not null;
create index if not exists idx_signup_code_redemptions_code
  on signup_code_redemptions(code_id, redeemed_at desc);

/* ── RLS ──────────────────────────────────────────────────────────────────── */

alter table hotel_subscriptions enable row level security;
alter table signup_codes enable row level security;
alter table signup_code_redemptions enable row level security;

-- Members see their own hotel's billing state (the app shows status and renewal
-- date); only the service-role webhook writes it.
drop policy if exists hotel_subscriptions_read on hotel_subscriptions;
create policy hotel_subscriptions_read on hotel_subscriptions
  for select using (is_hotel_accessible(hotel_id));
revoke insert, update, delete on hotel_subscriptions from anon, authenticated;

-- Codes and their redemptions are platform-admin only: Jake and Corey issue
-- them, and the redemption list carries other customers' admin emails, so it
-- must never be readable by a hotel member.
drop policy if exists signup_codes_admin on signup_codes;
create policy signup_codes_admin on signup_codes
  for all using (is_platform_admin()) with check (is_platform_admin());

drop policy if exists signup_code_redemptions_admin on signup_code_redemptions;
create policy signup_code_redemptions_admin on signup_code_redemptions
  for select using (is_platform_admin());
revoke insert, update, delete on signup_code_redemptions from anon, authenticated;

/* ── updated_at ───────────────────────────────────────────────────────────── */

-- Same shape as pms_connection_secrets_touch_updated_at: this schema keeps a
-- touch function per table rather than one shared helper.
create or replace function public.billing_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_hotel_subscriptions_touch on public.hotel_subscriptions;
create trigger trg_hotel_subscriptions_touch
  before update on public.hotel_subscriptions
  for each row execute function public.billing_touch_updated_at();

drop trigger if exists trg_signup_codes_touch on public.signup_codes;
create trigger trg_signup_codes_touch
  before update on public.signup_codes
  for each row execute function public.billing_touch_updated_at();
