-- RLS hardening: close the DELETE hole and stop handing PMS credentials to
-- the browser.
--
-- Two independent problems, both found by an adversarial review of the schema.
--
-- 1. Postgres never applies WITH CHECK to DELETE. Every policy shaped
--    `for all using (is_hotel_accessible(...)) with check (can_manage_hotel(...))`
--    therefore reads as "members may read, managers may write" but actually
--    lets ANY member — including staff and viewer — DELETE rows. Supabase
--    grants `authenticated` DELETE on public tables by default and the browser
--    speaks PostgREST directly, so RLS is the only gate. A viewer could delete
--    pricing rules, reservations, published prices, or the evaluation audit
--    trail. Each policy is split per command below; only DELETE changes
--    behavior (UPDATE was already blocked by its WITH CHECK, since
--    can_manage_hotel is evaluated against the CALLER either way).
--
-- 2. The Vault RPCs were granted to `authenticated`, so any manager could call
--    pms_secret_get from the browser and read decrypted PMS tokens, then drive
--    the PMS directly outside MAYA. That defeats the whole point of keeping
--    pms_connection_secrets RLS-locked with no policy. Every real caller in the
--    app uses the service-role client, so the grant is pure attack surface.
--
-- Note the scope expression differs per table: rule-child tables have no
-- hotel_id of their own and reach it through rule_hotel_id(rule_id). The pairs
-- below are transcribed from the existing policies, not assumed.

-- ── 1. Per-command policies for hotel-scoped tables ─────────────────────────

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('pms_connections',         'hotel_id'),
      ('hotel_settings',          'hotel_id'),
      ('room_types',              'hotel_id'),
      ('room_constraints',        'hotel_id'),
      ('reservations',            'hotel_id'),
      ('occupancy_metrics',       'hotel_id'),
      ('pricing_rules',           'hotel_id'),
      ('rule_applications',       'hotel_id'),
      ('pricing_runs',            'hotel_id'),
      ('pricing_decisions',       'hotel_id'),
      ('rate_updates',            'hotel_id'),
      ('audit_events',            'hotel_id'),
      ('market_events',           'hotel_id'),
      ('competitor_rates',        'hotel_id'),
      ('stay_date_snapshot',      'hotel_id'),
      ('published_price',         'hotel_id'),
      ('ladder_transition_event', 'hotel_id'),
      ('pickup_event',            'hotel_id'),
      ('evaluation_audit',        'hotel_id'),
      ('onboarding_states',       'hotel_id'),
      ('onboarding_findings',     'hotel_id'),
      ('hotel_closed_periods',    'hotel_id'),
      -- Rule children: no hotel_id column, scoped through the parent rule.
      ('rule_condition',          'rule_hotel_id(rule_id)'),
      ('rule_signal_room_type',   'rule_hotel_id(rule_id)'),
      ('rule_affected_room_type', 'rule_hotel_id(rule_id)'),
      ('pricing_rule_conditions', 'rule_hotel_id(rule_id)'),
      ('pricing_rule_room_types', 'rule_hotel_id(rule_id)'),
      ('ladder_rule_state',       'rule_hotel_id(rule_id)')
    ) as t(tbl, scope)
  loop
    -- Skip tables this database does not have (schema variants differ).
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', r.tbl || '_access', r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_read',   r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_insert', r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_update', r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_delete', r.tbl);

    execute format(
      'create policy %I on public.%I for select using (is_hotel_accessible(%s))',
      r.tbl || '_read', r.tbl, r.scope);
    execute format(
      'create policy %I on public.%I for insert with check (can_manage_hotel(%s))',
      r.tbl || '_insert', r.tbl, r.scope);
    execute format(
      'create policy %I on public.%I for update using (can_manage_hotel(%s)) with check (can_manage_hotel(%s))',
      r.tbl || '_update', r.tbl, r.scope, r.scope);
    execute format(
      'create policy %I on public.%I for delete using (can_manage_hotel(%s))',
      r.tbl || '_delete', r.tbl, r.scope);
  end loop;
end $$;

-- assumption_challenges already ships split policies (see its own migration);
-- hotel_memberships_write already gates USING on can_manage_hotel. Both are
-- intentionally left alone.

-- ── 2. Vault RPCs are service-role only ─────────────────────────────────────

revoke execute on function public.pms_secret_get(uuid, public.pms_type) from authenticated;
revoke execute on function public.pms_secret_set(uuid, public.pms_type, jsonb) from authenticated;
revoke execute on function public.pms_secret_delete(uuid, public.pms_type) from authenticated;
