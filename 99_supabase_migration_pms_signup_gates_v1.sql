-- Per-PMS control over whether signup needs an access code.
--
-- The access code is a single global requirement today — every checkout, every
-- PMS. Jake wants to open specific integrations to true self-serve once they've
-- proven out with the first beta hotels, independently of each other (Cloudbeds
-- open, Think Reservations still gated, say), without touching the scarcity
-- gate as a system-wide switch.
--
-- Every row starts at `true`, which is today's exact behavior — nothing changes
-- until someone flips one off in Command Center. A missing row is read as
-- required too (see pmsSignupCodeRequired in src/lib/billing/pms-gates.ts):
-- failing toward MORE scarcity is the safe direction, since the cost of a
-- missing row reading as "gate on" is a confused admin, not an unvetted signup.
--
-- This governs the ACCESS code only — whether checkout can proceed with none at
-- all. A discount/trial code, if the customer has one, is validated and honoured
-- exactly the same regardless of which way this switch is set.
--
-- Run any time. Idempotent.

create table if not exists public.pms_signup_gates (
  pms_type              text primary key,
  requires_signup_code  boolean not null default true,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users(id) on delete set null
);

alter table public.pms_signup_gates enable row level security;

-- No policy for anon or authenticated: nobody signing up needs to read this
-- table directly, and nobody but a platform admin should be able to write it.
-- Reads and writes both go through the service-role client from
-- /api/admin/pms-gates, which gates on requirePlatformAdmin before ever
-- touching the table — the same pattern the other Command Center admin routes
-- already use (see api/admin/signup-codes).
revoke all on public.pms_signup_gates from anon, authenticated;

insert into public.pms_signup_gates (pms_type)
values ('cloudbeds'), ('mews'), ('think')
on conflict (pms_type) do nothing;
