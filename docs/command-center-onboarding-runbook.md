# Command Center — Onboarding Runbook (PR 1 era)

After `99_supabase_migration_command_center_v1.sql` is applied, the DB is capable of the full onboarding flow but the UI wizard doesn't exist yet (PRs 2–5). This doc gives you:

1. Smoke tests that prove PR 1 is working.
2. A **manual runbook** you can use *today* to onboard a real customer end-to-end via SQL Editor + the Supabase Auth dashboard.
3. What each future PR replaces in this runbook so you can retire steps as pages ship.

All SQL below runs in **Supabase Dashboard → SQL Editor**, which executes as `postgres` and bypasses RLS. Do NOT try to run these from the app — the tables you're touching (`app_roles`, `pending_memberships`) intentionally have no grants for `authenticated`.

---

## Part 1 — Smoke tests (5 minutes)

### 1.1 Confirm the objects exist

```sql
select 'app_roles'                as obj, exists (select 1 from pg_class where relname = 'app_roles' and relnamespace = 'public'::regnamespace) as ok
union all select 'pending_memberships',    exists (select 1 from pg_class where relname = 'pending_memberships' and relnamespace = 'public'::regnamespace)
union all select 'platform_audit_events',  exists (select 1 from pg_class where relname = 'platform_audit_events' and relnamespace = 'public'::regnamespace)
union all select 'is_platform_admin fn',   exists (select 1 from pg_proc where proname = 'is_platform_admin')
union all select 'accept_pending fn',      exists (select 1 from pg_proc where proname = 'accept_pending_memberships_for_user')
union all select 'trg on auth.users',      exists (select 1 from pg_trigger where tgname = 'trg_accept_pending_memberships');
```

All rows should be `ok = true`.

### 1.2 Bootstrap yourself as platform admin (one-time)

```sql
-- Find your auth.users id
select id, email, created_at from auth.users where email = 'scdeloach16@gmail.com';

-- Grant platform_admin (replace the uuid)
insert into public.app_roles (user_id, role)
values ('<paste-your-uuid>', 'platform_admin')
on conflict do nothing;

-- Verify
select public.is_platform_admin('<paste-your-uuid>');   -- true
```

### 1.3 Prove the RLS bypass is live

Sign into the Next.js app as yourself and hit any page that lists hotels — you should see **every hotel in the DB**, not just ones you have a `hotel_memberships` row for. If you don't have any hotels outside your memberships yet, run this SQL as postgres to be sure:

```sql
-- As postgres in SQL Editor (bypasses RLS)
select count(*) as total_hotels from public.hotels;

-- Then, from the app while signed in as you, hit /admin (which won't exist yet)
-- or use the whoami test in the app if you have one. Alternatively:
select count(*) from public.hotels;   -- run this as your JWT user via /rest/v1/hotels?select=count
```

Easier way: create a throwaway hotel in SQL Editor, then confirm you can SELECT it from the app.

```sql
insert into public.hotels (name, timezone, currency) values ('Bypass Test Hotel', 'UTC', 'USD');
```

Sign into your app; the `/pms` or `/calendar` page dropdown (if you have property-select wired up) should include "Bypass Test Hotel" even though no `hotel_memberships` row exists for you against it.

Delete it when done: `delete from public.hotels where name = 'Bypass Test Hotel';`

### 1.4 Prove the invite-accept trigger works (dry run)

Pick an email you can receive at that is **not already in auth.users**. Then:

```sql
-- 1. Pre-stage a pending membership
insert into public.pending_memberships (email, hotel_id, role)
select 'trigger-test@yourdomain.com'::citext,
       id,
       'manager'::hotel_membership_role
from public.hotels
order by created_at desc limit 1
returning *;

-- 2. From Supabase Dashboard → Authentication → Users, click "Invite user"
--    and enter trigger-test@yourdomain.com. Supabase sends a magic link.

-- 3. Accept the invite in a browser (or copy the token URL into an incognito window).
--    Once you set the password, the trigger fires.

-- 4. Verify materialization
select * from public.pending_memberships where email = 'trigger-test@yourdomain.com';
-- status should be 'accepted', accepted_at set

select hm.role, hm.status
from public.hotel_memberships hm
join auth.users u on u.id = hm.user_id
where u.email = 'trigger-test@yourdomain.com';
-- one row: role = 'manager', status = 'active'
```

Clean up: delete the auth user (Auth UI), then rerun `\d+ pending_memberships` — the FK will null the accepted_by, or if you want it fully gone: `delete from public.pending_memberships where email = 'trigger-test@yourdomain.com';`.

If steps 2–4 work end-to-end, the invite trigger is doing its job. This is the same code path that PR 4's wizard will use — the wizard just automates the `auth.admin.inviteUserByEmail` call and the pending-membership insert.

---

## Part 2 — Manual onboarding of a real customer (usable today)

Use this until PR 4's wizard ships. Every step is safe to re-run.

### Step 1 — Create the hotel

```sql
do $$
declare
  v_hotel_id uuid;
begin
  insert into public.hotels (
    name,
    timezone,
    currency,
    total_rooms_per_type,
    external_enterprise_id  -- optional; the customer's Mews enterprise id
  )
  values (
    'Customer Name Hotel',        -- REPLACE
    'America/Chicago',             -- REPLACE (IANA tz)
    'USD',                         -- REPLACE if not USD
    50,                            -- REPLACE with total rooms if you know per-category counts
    null                           -- REPLACE with Mews enterprise UUID if available
  )
  returning id into v_hotel_id;

  insert into public.hotel_settings (
    hotel_id,
    pricing_horizon_days,
    pickup_window_cycles,
    simulation_mode,
    rounding_mode
  )
  values (
    v_hotel_id,
    365,
    1,
    true,        -- start in simulation; flip to false after they review a few decisions
    'none'
  );

  raise notice 'Created hotel_id = %', v_hotel_id;
end $$;
```

Because you're a platform admin, the `auto_hotel_creator_membership` trigger will **not** grant you `hotel_admin` on this hotel — exactly what we want.

Grab the printed `hotel_id` for the next steps.

### Step 2 — Store Mews credentials in Vault

```sql
select public.pms_secret_set(
  p_hotel_id => '<hotel-id>'::uuid,
  p_pms_type => 'mews'::pms_type,
  p_secret   => jsonb_build_object(
    'clientToken', '<customer-client-token>',
    'accessToken', '<customer-access-token>',
    'enterpriseId', '<customer-enterprise-id>',  -- optional
    'env', 'production'                          -- or 'demo'
  )
);
```

Then insert the `pms_connections` metadata row that Edge/cron reads:

```sql
insert into public.pms_connections (hotel_id, pms_type, status, base_url)
values (
  '<hotel-id>'::uuid,
  'mews',
  'pending',                                     -- flip to 'connected' after test succeeds
  'https://api.mews.com/api/connector/v1'        -- or api.mews-demo.com/api/connector/v1
)
on conflict (hotel_id, pms_type) do update
  set base_url = excluded.base_url,
      updated_at = now();
```

### Step 3 — Verify the connection works

From the app, sign in as yourself (platform admin — you can access every hotel now), switch to the new hotel via the property-select, and use the existing `/pms` UI to click "Test connection". It calls `POST /api/pms/mews/test`, which will:

- Look up `pms_connections` for that hotel
- Call `pms_secret_get('<hotel-id>', 'mews')` — the RPC returns the decrypted JSON because you're a platform admin (bypasses `can_manage_hotel`)
- Ping Mews `configuration/get` and report enterprise name/id

If it succeeds, flip status to `connected`:

```sql
update public.pms_connections
   set status = 'connected',
       last_tested_at = now()
 where hotel_id = '<hotel-id>'::uuid and pms_type = 'mews';
```

### Step 4 — Pre-stage the customer's invite

```sql
insert into public.pending_memberships (email, hotel_id, role, invited_by)
values (
  'customer@theirdomain.com'::citext,
  '<hotel-id>'::uuid,
  'hotel_admin',
  (select id from auth.users where email = 'scdeloach16@gmail.com')  -- you
)
on conflict (email, hotel_id) do update
  set role = excluded.role,
      status = 'pending',
      invited_by = excluded.invited_by,
      invited_at = now();
```

### Step 5 — Send the Supabase Auth invite

In **Supabase Dashboard → Authentication → Users → Invite user**, enter the customer's email. Supabase emails a magic link with a one-time code.

*Optional: instead of the dashboard, run this via curl using your service-role key (handy for scripting later):*

```bash
curl -X POST "$SUPABASE_URL/auth/v1/invite" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"customer@theirdomain.com"}'
```

### Step 6 — Customer accepts

When the customer clicks the link:
1. Supabase creates their row in `auth.users`.
2. The `trg_accept_pending_memberships` trigger fires **immediately after that INSERT**.
3. The trigger finds their pending_memberships row (matched by email, citext), inserts a real `hotel_memberships` row (`role='hotel_admin'`, `status='active'`), and marks the pending row `accepted`.
4. The customer completes a password-set step (Supabase's default flow), lands in your app, and sees the hotel's data because RLS grants them access.

### Step 7 — Verify from the customer side

Impersonate the customer using their sign-in (or ask them to log in). They should:

- Land on `/` and see the dashboard populated for their hotel.
- Only see their one hotel in property-select (no bleed to other tenants).
- Not be able to hit `/admin` — the layout guard (PR 3) will redirect them, and until then, they simply have no `is_platform_admin()` bypass.

### Step 8 — Kick off the first sync

Either wait for the 5-min cron to fire, or trigger `POST /api/pms/mews/sync` manually from the customer's session (or yours). After a successful sync:

```sql
select last_sync_at from public.pms_connections where hotel_id = '<hotel-id>'::uuid;
-- Should be within the last minute or two
```

Reservation rows populate, room_types get created, and the app's calendar reflects real data.

**That's it — full onboarding without a wizard.**

---

## Part 3 — Diagnosis: what's still needed to make this a UX

The runbook above proves the DB layer is complete. Everything below is UI + server plumbing that automates the manual steps.

### Blockers before PR 4 can ship

| # | Item | Where | Status |
|---|---|---|---|
| 1 | `SUPABASE_SERVICE_ROLE_KEY` in Next.js env | `.env.local` locally, Vercel env in prod | **Not set for Next.js.** Only set as an Edge function secret today. |
| 2 | Supabase Auth "Additional Redirect URLs" allowlist | Supabase Dashboard → Authentication → URL Configuration | Add `http://localhost:3000/auth/accept-invite` and `https://<prod-domain>/auth/accept-invite` before PR 4 lands |
| 3 | Supabase Auth email template for invites | Supabase Dashboard → Authentication → Email Templates → Invite user | Default template is fine; consider adding the hotel name later via template variables |
| 4 | Disable public signup (optional) | Supabase Dashboard → Authentication → Providers → Email → "Enable sign ups" | Once invites are the only path in, flip this off. Not required for v1. |

### What each future PR replaces

| PR | Replaces which manual step |
|---|---|
| PR 2 (server foundation) | Adds `platform_invite_user`, `platform_set_membership_role`, `platform_remove_membership`, `platform_list_users`, `platform_list_hotel_users` RPCs. Adds `src/utils/supabase/admin.ts` + `requirePlatformAdmin` helper. Step 5 (invite curl) becomes a server-action call. |
| PR 3 (read-only /admin) | Replaces "hunt for hotel_id" — `/admin/hotels` shows every hotel; `/admin/hotels/[id]` shows the connection status and membership roster. |
| PR 4 (write paths + wizard) | Replaces steps 1–5 with a single multi-step form at `/admin/hotels/new`. Test-connection runs inline. Invite email fires on submit. `/auth/accept-invite` handles the customer's landing page (password set). |
| PR 5 (users + pending invites + polish) | `/admin/users` lets you grant/revoke `platform_admin` from the UI instead of `insert into app_roles`. `/admin/pending-invites` lets you resend/revoke invites without SQL. |

### Not blocking but worth deciding early

- **Multi-property customers.** The plan defers `organizations`. Two customers who happen to share owners can be onboarded as two separate hotels for now. When a real chain shows up, plan says add an `organizations` grouping in a separate migration; nothing in v1 blocks that.
- **Re-invite / rotate credentials from the wizard.** Currently the wizard covers first-time setup. Rotations happen in `/admin/hotels/[id]/pms` (PR 4). If you want to invite a *second* user to an already-active hotel, that's the InviteUserDialog on the hotel detail page (also PR 4).
- **Auth invite redirect URL** — needs `MAYA_INVITE_REDIRECT_BASE` env var so dev vs prod use different URLs. Cover in PR 4 alongside the `/auth/accept-invite` page.

---

## Cleanup recipes

If a test invite got stuck:

```sql
-- Revoke a pending invite
update public.pending_memberships
   set status = 'revoked'
 where email = '<email>'::citext and hotel_id = '<hotel-id>'::uuid;

-- Nuke a test hotel (cascades to memberships, pms_connections, pms_connection_secrets via triggers)
delete from public.hotels where id = '<hotel-id>'::uuid;

-- Remove yourself from platform_admin (careful)
delete from public.app_roles where user_id = '<your-uuid>' and role = 'platform_admin';
```
