# Command Center — Deployment & Secrets

The Command Center (`/admin/*` + `/auth/accept-invite` + `/api/admin/*`) needs three pieces of configuration that are new to this feature. Do these once per environment.

---

## 1. Database — apply the two migrations (in order)

If you already applied `99_supabase_migration_command_center_v1.sql`, only run **v2**. If not, run both in order.

In Supabase Dashboard → SQL Editor:

```
99_supabase_migration_command_center_v1.sql   (already applied)
99_supabase_migration_command_center_v2.sql   ← run this next
```

`v2` adds the `platform_*` RPCs and the `platform_users_view` that the /admin pages call. It's idempotent — safe to re-run.

Verify:

```sql
select proname from pg_proc where proname like 'platform\_%' order by proname;
```

You should see: `platform_grant_role`, `platform_invite_user`, `platform_list_hotel_users`, `platform_list_hotels`, `platform_list_pending_invites`, `platform_list_users`, `platform_log_event`, `platform_remove_membership`, `platform_revoke_pending`, `platform_revoke_role`, `platform_set_membership_role`.

---

## 2. Environment variables (Next.js app)

### `SUPABASE_SERVICE_ROLE_KEY` (required)

Server-only key that bypasses RLS. **Never expose to the browser.**

- **Where to get it:** Supabase Dashboard → Project Settings → API → Service role secret.
- **Local dev:** `.env.local` (this file is git-ignored).
  ```
  SUPABASE_SERVICE_ROLE_KEY=<paste the service role JWT>
  ```
- **Vercel:** Project Settings → Environment Variables. Scope to **Production** and **Preview** only (do not add to Development if you want /admin to fail closed on preview deployments without the key).

Guardrails already in the code:
- `src/utils/supabase/admin.ts` starts with `import "server-only"` — importing it from a client component causes a build error.
- `requirePlatformAdmin` returns HTTP 503 if the key is missing, so /admin renders a helpful banner instead of leaking the misconfiguration.

### `MAYA_INVITE_REDIRECT_BASE` (required if inviting users)

Base URL used in the invite magic-link redirect. Must match the deployed host and must be allowlisted in Supabase (step 3 below).

- **Local dev:** `MAYA_INVITE_REDIRECT_BASE=http://localhost:3000`
- **Vercel prod:** `MAYA_INVITE_REDIRECT_BASE=https://<your-domain>`

Set in `.env.local` and Vercel Environment Variables. Do NOT include a trailing slash.

### Existing vars — no changes

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `MAYA_DEFAULT_HOTEL_ID` — unchanged.

---

## 3. Supabase Dashboard — Auth configuration

### 3.1 Allowlist the invite-accept URL

Dashboard → Authentication → URL Configuration → **Additional Redirect URLs**. Add:

- `http://localhost:3000/auth/accept-invite`
- `https://<your-prod-domain>/auth/accept-invite`

If this isn't allowlisted, Supabase silently strips the redirect and the customer lands on the default post-auth page — the pending-membership trigger still fires so they'll have access, but the "set your password" UX is skipped.

### 3.2 Confirm the invite email template

Dashboard → Authentication → Email Templates → **Invite user**.

Default template is fine. If you want a small tweak, the placeholders `{{ .ConfirmationURL }}` and `{{ .Email }}` are the ones you'll use. The link routes to whatever you allowlisted in 3.1.

### 3.3 (Optional) Disable public sign-ups

Once the Command Center is live and you're only onboarding via invites, Dashboard → Authentication → Providers → Email → **Enable sign-ups: off**. Existing self-signup on `/login` "Create Account" button will fail; the invite flow is unaffected.

---

## 4. Bootstrap yourself as platform admin

Only needed once per environment. Run in SQL Editor:

```sql
-- Look up your user id
select id, email from auth.users where email = 'scdeloach16@gmail.com';

-- Grant the role
insert into public.app_roles (user_id, role)
values ('<paste-uuid>', 'platform_admin')
on conflict do nothing;

-- Verify (should return true)
select public.is_platform_admin('<paste-uuid>');
```

Sign into the app and navigate to `/admin`. If the RLS bypass and env vars are wired correctly you'll see the Command Center dashboard.

---

## 5. Testing checklist for a full onboarding

Run through this once end-to-end on staging (or your dev DB with a real email you can receive at):

- [ ] `/admin` loads without a redirect. Overview shows counts.
- [ ] `/admin/hotels/new` → fill Basics + Settings → PMS with valid Mews demo tokens → "Test connection" reports enterprise info → enter your own email as invite recipient → Submit.
- [ ] Redirect lands on `/admin/hotels/[hotelId]`. Overview + PMS card + Members card all populated.
- [ ] Check your inbox for the Supabase invite email. Click the link (or copy into an incognito window).
- [ ] Land on `/auth/accept-invite`. Set a password. Redirect to `/`.
- [ ] Log out, log back in as the invited user. You see only the new hotel; property-select is scoped.
- [ ] From an incognito platform-admin session, `/admin/hotels/[hotelId]` shows the accepted user in Members with role `hotel_admin`, and the pending invite row is gone (or marked `accepted` on the Pending Invites page).
- [ ] `/admin/users` shows the new user. Toggling `platform_admin` grants/revokes correctly.
- [ ] `/admin/pending-invites` — create another pending invite from a hotel detail page, then Resend and Revoke buttons both work.
- [ ] `/pms/mews/test` still works from a normal user's session (existing UI wasn't touched).

---

## 6. Rollback

If something goes wrong after applying `v2`:

```sql
-- Undo v2 only (leaves v1 in place)
drop function if exists public.platform_grant_role(uuid, public.app_role);
drop function if exists public.platform_revoke_role(uuid, public.app_role);
drop function if exists public.platform_revoke_pending(uuid);
drop function if exists public.platform_remove_membership(uuid, uuid);
drop function if exists public.platform_set_membership_role(uuid, uuid, public.hotel_membership_role);
drop function if exists public.platform_invite_user(citext, uuid, public.hotel_membership_role, uuid);
drop function if exists public.platform_log_event(text, text, text, uuid, jsonb);
drop function if exists public.platform_list_pending_invites(uuid);
drop function if exists public.platform_list_hotels(text);
drop function if exists public.platform_list_hotel_users(uuid);
drop function if exists public.platform_list_users(text, int, int);
drop view if exists public.platform_users_view;
```

The /admin UI will render a "not configured" banner until `v2` is reapplied.

---

## Files added by this PR set

**SQL (root `MAYA/`):**
- `99_supabase_migration_command_center_v2.sql` — new
- `02_supabase_schema.sql` — appended (view + 10 RPCs)

**Next.js app (`MAYA/maya-rms/`):**
- `.env.example` — added `SUPABASE_SERVICE_ROLE_KEY`, `MAYA_INVITE_REDIRECT_BASE`
- `src/utils/supabase/admin.ts` — service-role client factory (server-only)
- `src/lib/admin/require-platform-admin.ts` — auth gate for admin routes
- `src/lib/admin/{types,hotels,memberships,users,pms}.ts` — server-side helpers
- `src/app/admin/layout.tsx` — layout guard
- `src/app/admin/page.tsx` — overview
- `src/app/admin/hotels/page.tsx` — hotels list
- `src/app/admin/hotels/new/page.tsx` — create-hotel wizard host
- `src/app/admin/hotels/[hotelId]/page.tsx` — hotel detail
- `src/app/admin/users/page.tsx` — users list
- `src/app/admin/pending-invites/page.tsx` — pending invites list
- `src/app/auth/accept-invite/page.tsx` — invite landing (set password)
- `src/app/api/admin/hotels/route.ts` — POST create
- `src/app/api/admin/hotels/[hotelId]/pms/mews/route.ts` — PUT / DELETE credentials
- `src/app/api/admin/hotels/[hotelId]/pms/mews/test/route.ts` — POST test
- `src/app/api/admin/hotels/[hotelId]/memberships/invite/route.ts` — POST invite
- `src/app/api/admin/hotels/[hotelId]/memberships/[membershipId]/route.ts` — PATCH / DELETE
- `src/app/api/admin/pending-invites/[pendingId]/route.ts` — POST resend / DELETE revoke
- `src/app/api/admin/pms/mews/test/route.ts` — POST test (wizard-only, no hotel id)
- `src/app/api/admin/users/[userId]/platform-admin/route.ts` — PUT / DELETE grant/revoke
- `src/components/admin/{admin-top-nav,status-pill,platform-admin-toggle,invite-row-actions,hotel-pms-card,hotel-memberships-card,create-hotel-wizard}.tsx` — UI
