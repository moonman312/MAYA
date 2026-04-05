-- MAYA seed data: hotels + hotel_memberships (no organizations)
-- Run this after:
--   1) supabase_base_schema.sql
--   2) supabase_schema.sql
--
-- IMPORTANT:
-- - Update the email values below to users that already exist in auth.users.
-- - This script is idempotent for hotels/memberships/settings/room types.

do $$
declare
  -- REQUIRED: set to your own authenticated Supabase user email
  v_primary_admin_email text := 'cdeloach16@gmail.com';

  -- OPTIONAL: manager scoped to one hotel only
  v_manager_email text := 'manager@example.com';

  v_primary_admin_user_id uuid;
  v_manager_user_id uuid;

  v_hotel_1_id uuid;
  v_hotel_2_id uuid;
  v_hotel_3_id uuid;
begin
  select u.id
  into v_primary_admin_user_id
  from auth.users u
  where lower(u.email) = lower(v_primary_admin_email)
  limit 1;

  if v_primary_admin_user_id is null then
    select u.id
    into v_primary_admin_user_id
    from auth.users u
    order by u.created_at asc
    limit 1;

    if v_primary_admin_user_id is null then
      raise exception
        'No auth.users rows found. Create a user first (Auth UI or app sign-up), then rerun seed.';
    else
      raise notice
        'Primary admin email % not found. Falling back to first auth user id %.',
        v_primary_admin_email,
        v_primary_admin_user_id;
    end if;
  end if;

  select u.id
  into v_manager_user_id
  from auth.users u
  where lower(u.email) = lower(v_manager_email)
  limit 1;

  insert into hotels (name, timezone, currency, is_active, total_rooms_per_type, external_enterprise_id)
  values ('The Grand Marina', 'America/Los_Angeles', 'USD', true, 100, 'enterprise-grand-marina')
  on conflict (name) do update
    set timezone = excluded.timezone,
        currency = excluded.currency,
        is_active = excluded.is_active,
        total_rooms_per_type = excluded.total_rooms_per_type,
        external_enterprise_id = excluded.external_enterprise_id,
        updated_at = now()
  returning id into v_hotel_1_id;

  insert into hotels (name, timezone, currency, is_active, total_rooms_per_type, external_enterprise_id)
  values ('Skyline Tower Hotel', 'America/Los_Angeles', 'USD', true, 120, 'enterprise-skyline-tower')
  on conflict (name) do update
    set timezone = excluded.timezone,
        currency = excluded.currency,
        is_active = excluded.is_active,
        total_rooms_per_type = excluded.total_rooms_per_type,
        external_enterprise_id = excluded.external_enterprise_id,
        updated_at = now()
  returning id into v_hotel_2_id;

  insert into hotels (name, timezone, currency, is_active, total_rooms_per_type, external_enterprise_id)
  values ('Harbor View Resort', 'America/Los_Angeles', 'USD', true, 85, 'enterprise-harbor-view')
  on conflict (name) do update
    set timezone = excluded.timezone,
        currency = excluded.currency,
        is_active = excluded.is_active,
        total_rooms_per_type = excluded.total_rooms_per_type,
        external_enterprise_id = excluded.external_enterprise_id,
        updated_at = now()
  returning id into v_hotel_3_id;

  -- Primary admin: hotel_admin on all three (multi-property user)
  insert into hotel_memberships (hotel_id, user_id, role, status)
  values
    (v_hotel_1_id, v_primary_admin_user_id, 'hotel_admin', 'active'),
    (v_hotel_2_id, v_primary_admin_user_id, 'hotel_admin', 'active'),
    (v_hotel_3_id, v_primary_admin_user_id, 'hotel_admin', 'active')
  on conflict (hotel_id, user_id) do update
    set role = excluded.role,
        status = excluded.status;

  if v_manager_user_id is not null then
    insert into hotel_memberships (hotel_id, user_id, role, status)
    values (v_hotel_1_id, v_manager_user_id, 'manager', 'active')
    on conflict (hotel_id, user_id) do update
      set role = excluded.role,
          status = excluded.status;
  else
    raise notice 'Manager email % not found in auth.users. Skipping manager hotel membership.', v_manager_email;
  end if;

  insert into hotel_settings (hotel_id, pricing_horizon_days, pickup_window_cycles, simulation_mode, rounding_mode)
  values
    (v_hotel_1_id, 365, 1, true, 'none'),
    (v_hotel_2_id, 365, 1, true, 'none'),
    (v_hotel_3_id, 365, 1, true, 'none')
  on conflict (hotel_id) do update
    set pricing_horizon_days = excluded.pricing_horizon_days,
        pickup_window_cycles = excluded.pickup_window_cycles,
        simulation_mode = excluded.simulation_mode,
        rounding_mode = excluded.rounding_mode,
        updated_at = now();

  insert into room_types (hotel_id, external_room_type_id, name, display_name, is_active)
  values
    (v_hotel_1_id, 'STD', 'Standard', 'Standard Room', true),
    (v_hotel_1_id, 'DLX', 'Deluxe', 'Deluxe Room', true),
    (v_hotel_1_id, 'STE', 'Suite', 'Suite', true),
    (v_hotel_2_id, 'STD', 'Standard', 'Standard Room', true),
    (v_hotel_2_id, 'DLX', 'Deluxe', 'Deluxe Room', true),
    (v_hotel_2_id, 'STE', 'Suite', 'Suite', true),
    (v_hotel_3_id, 'STD', 'Standard', 'Standard Room', true),
    (v_hotel_3_id, 'DLX', 'Deluxe', 'Deluxe Room', true),
    (v_hotel_3_id, 'STE', 'Suite', 'Suite', true)
  on conflict (hotel_id, external_room_type_id) do update
    set name = excluded.name,
        display_name = excluded.display_name,
        is_active = excluded.is_active,
        updated_at = now();

  raise notice 'Seed complete. hotel_1=% hotel_2=% hotel_3=%', v_hotel_1_id, v_hotel_2_id, v_hotel_3_id;
end $$;

select h.id as hotel_id, h.name as hotel_name
from hotels h
order by h.created_at asc;

-- Set MAYA_DEFAULT_HOTEL_ID in maya-rms/.env.local to one of the hotel_id values above.
