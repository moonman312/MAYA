-- MAYA Rate Push v1 Migration
-- Adds the outbound rate-delivery layer: a ledger of what prices were pushed to
-- each PMS (idempotency + observability) and a cache of the resolved per-room
-- rate target on the connection.
--
-- Run AFTER 02_supabase_schema.sql. Safe to re-run (idempotent guards).
--
-- Safety model (enforced in code, documented here):
--   • Rates are pushed ONLY for hotels in LIVE mode (hotel_settings.simulation_mode = false).
--   • The Edge push is additionally gated by env MAYA_PUSH_RATES (default off).
--   • Only prices that CHANGED since the last successful push are sent
--     (compared against public.rate_updates below).

begin;

-- ============================================================================
-- 1. pms_connections: cache the resolved push target (external_room_type_id -> rateID)
--    so we don't call getRatePlans every tick. jsonb keeps it vendor-agnostic
--    (Cloudbeds rateID map today; Mews RateId/category map when that lands).
-- ============================================================================

alter table public.pms_connections
  add column if not exists push_rate_targets jsonb;

comment on column public.pms_connections.push_rate_targets is
  'Cached rate-push target map, resolved from the PMS (e.g. Cloudbeds '
  'external_room_type_id -> base rateID). Refreshed lazily by the rate-push layer.';

-- ============================================================================
-- 2. rate_updates — latest push state per (hotel, room_type, stay_date).
--    Upserted on every push attempt: `price` is the last price we tried to send,
--    `status` records the outcome. Idempotency = skip when status='sent' and the
--    engine's published_price still equals this price.
-- ============================================================================

create table if not exists public.rate_updates (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  pms_type public.pms_type not null,
  room_type_id uuid references public.room_types(id) on delete cascade,
  external_room_type_id text,
  stay_date date not null,
  price numeric(10,2) not null,
  external_rate_id text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  pms_job_reference text,
  error text,
  attempts integer not null default 1,
  pushed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, room_type_id, stay_date)
);

create index if not exists idx_rate_updates_hotel_stay_date
  on public.rate_updates (hotel_id, stay_date);
create index if not exists idx_rate_updates_hotel_status
  on public.rate_updates (hotel_id, status);

comment on table public.rate_updates is
  'Ledger of computed prices pushed to the PMS. One row per '
  '(hotel, room_type, stay_date), upserted on each push. Drives idempotency '
  '(only changed prices are re-sent) and observability (status/job/error).';

-- touch updated_at
create or replace function public.rate_updates_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_rate_updates_touch on public.rate_updates;
create trigger trg_rate_updates_touch
  before update on public.rate_updates
  for each row execute function public.rate_updates_touch_updated_at();

-- ============================================================================
-- 3. RLS: service role (cron/Edge) writes; hotel managers may read their rows.
-- ============================================================================

alter table public.rate_updates enable row level security;

revoke all on public.rate_updates from anon;
grant select on public.rate_updates to authenticated;
grant select, insert, update, delete on public.rate_updates to service_role;

drop policy if exists rate_updates_read on public.rate_updates;
create policy rate_updates_read on public.rate_updates
  for select to authenticated
  using (public.can_manage_hotel(hotel_id));

commit;
