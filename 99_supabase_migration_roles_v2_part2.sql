-- Hotel roles v2, part 2 — capabilities, hierarchy and guards.
--
-- Run 99_supabase_migration_roles_v2.sql FIRST (it adds the enum values;
-- Postgres will not let a new enum value be used in the same transaction
-- that created it, which is why this is a separate file).

-- ── Rank: the hierarchy in one place ───────────────────────────────────────

create or replace function public.hotel_role_rank(p_role text)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'hotel_admin'     then 40
    when 'general_manager' then 30
    when 'revenue_manager' then 20
    when 'staff'           then 10
    when 'viewer'          then 0
    else -1
  end
$$;

/** The caller's rank at this hotel; -1 when they hold no active membership. */
create or replace function public.my_hotel_rank(target_hotel_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select public.hotel_role_rank(hm.role::text)
       from hotel_memberships hm
      where hm.hotel_id = target_hotel_id
        and hm.user_id = auth.uid()
        and hm.status = 'active'
      order by public.hotel_role_rank(hm.role::text) desc
      limit 1),
    -1)
$$;

-- ── Capability tiers ───────────────────────────────────────────────────────

-- May change pricing: rules, rates, floor/ceiling guardrails, reverts,
-- assumption challenges. Revenue Manager and up.
create or replace function public.can_manage_hotel(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_admin()
      or has_hotel_role(
           target_hotel_id,
           array['hotel_admin', 'general_manager', 'revenue_manager']
         )
$$;

-- May change commercial state: going live out of simulation, the PMS
-- connection, billing, and who holds which role. General Manager and up.
create or replace function public.can_manage_finances(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_admin()
      or has_hotel_role(
           target_hotel_id,
           array['hotel_admin', 'general_manager']
         )
$$;

-- Reading is unchanged: every active member of any role.
create or replace function public.is_hotel_accessible(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_admin()
      or has_hotel_role(
           target_hotel_id,
           array['hotel_admin', 'general_manager', 'revenue_manager', 'staff', 'viewer']
         )
$$;

revoke all on function public.hotel_role_rank(text) from public;
revoke all on function public.my_hotel_rank(uuid) from public;
revoke all on function public.can_manage_finances(uuid) from public;
grant execute on function public.hotel_role_rank(text) to authenticated, service_role;
grant execute on function public.my_hotel_rank(uuid) to authenticated, service_role;
grant execute on function public.can_manage_finances(uuid) to authenticated, service_role;

-- ── Membership writes are rank-checked ─────────────────────────────────────
-- You may grant a role at or below your own rank, and never above it — which
-- means you cannot promote yourself past where you already are. Platform
-- admins and the service role bypass this entirely.

create or replace function public.enforce_membership_rank()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_rank integer;
  target_rank integer;
  previous_rank integer;
begin
  if (select auth.role()) = 'service_role' or public.is_platform_admin() then
    return new;
  end if;

  actor_rank := public.my_hotel_rank(new.hotel_id);
  target_rank := public.hotel_role_rank(new.role::text);

  -- Only General Manager and up may touch membership at all.
  if actor_rank < public.hotel_role_rank('general_manager') then
    raise exception 'Changing team roles requires General Manager access'
      using errcode = '42501';
  end if;

  if target_rank > actor_rank then
    raise exception 'You cannot grant a role above your own'
      using errcode = '42501';
  end if;

  -- Demoting or removing someone senior to you is equally off limits.
  if tg_op = 'UPDATE' then
    previous_rank := public.hotel_role_rank(old.role::text);
    if previous_rank > actor_rank then
      raise exception 'You cannot change the role of someone above you'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_membership_rank on hotel_memberships;
create trigger trg_enforce_membership_rank
  before insert or update on hotel_memberships
  for each row execute function public.enforce_membership_rank();

create or replace function public.enforce_membership_delete_rank()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) = 'service_role' or public.is_platform_admin() then
    return old;
  end if;
  if public.my_hotel_rank(old.hotel_id) < public.hotel_role_rank('general_manager')
     or public.hotel_role_rank(old.role::text) > public.my_hotel_rank(old.hotel_id) then
    raise exception 'You cannot remove a member at or above your own level'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_enforce_membership_delete_rank on hotel_memberships;
create trigger trg_enforce_membership_delete_rank
  before delete on hotel_memberships
  for each row execute function public.enforce_membership_delete_rank();

-- Membership policies follow the same tiers (split per command: a FOR ALL
-- policy's WITH CHECK never governs DELETE).
drop policy if exists hotel_memberships_write on hotel_memberships;
drop policy if exists hotel_memberships_manage_insert on hotel_memberships;
create policy hotel_memberships_manage_insert on hotel_memberships
  for insert with check (can_manage_finances(hotel_id));
drop policy if exists hotel_memberships_manage_update on hotel_memberships;
create policy hotel_memberships_manage_update on hotel_memberships
  for update using (can_manage_finances(hotel_id))
  with check (can_manage_finances(hotel_id));
drop policy if exists hotel_memberships_manage_delete on hotel_memberships;
create policy hotel_memberships_manage_delete on hotel_memberships
  for delete using (can_manage_finances(hotel_id));

-- ── Commercial state is General Manager and up ─────────────────────────────

drop policy if exists pms_connections_insert on pms_connections;
create policy pms_connections_insert on pms_connections
  for insert with check (can_manage_finances(hotel_id));
drop policy if exists pms_connections_update on pms_connections;
create policy pms_connections_update on pms_connections
  for update using (can_manage_finances(hotel_id))
  with check (can_manage_finances(hotel_id));
drop policy if exists pms_connections_delete on pms_connections;
create policy pms_connections_delete on pms_connections
  for delete using (can_manage_finances(hotel_id));

-- simulation_mode lives on hotel_settings alongside strategy_floor /
-- strategy_ceiling, which a Revenue Manager legitimately edits. Gating the
-- whole table would take the guardrails away from them, so the switch itself
-- is guarded at column level instead.
create or replace function public.enforce_simulation_mode_rank()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) = 'service_role' or public.is_platform_admin() then
    return new;
  end if;
  if new.simulation_mode is distinct from old.simulation_mode
     and not public.can_manage_finances(new.hotel_id) then
    raise exception 'Taking pricing live requires General Manager access'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_simulation_mode_rank on hotel_settings;
create trigger trg_enforce_simulation_mode_rank
  before update on hotel_settings
  for each row execute function public.enforce_simulation_mode_rank();
