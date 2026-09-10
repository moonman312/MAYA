# PMS Integrations — Status

Where each PMS integration stands, and exactly what's blocking each one from being fully wired up.

| PMS | Auth kind | UI ready | Backend ready | Blocking on |
|---|---|---|---|---|
| Mews | Static tokens | ✅ | ✅ | Nothing — fully working end-to-end |
| Cloudbeds | OAuth2 (authorization code) | ✅ | ✅ scaffolding + OAuth flow | `CLOUDBEDS_CLIENT_ID` / `CLOUDBEDS_CLIENT_SECRET` from vendor + redirect URI whitelist on their side + app-type change to writable |
| Think Reservations | OAuth2 (Auth0) | ✅ | ✅ scaffolding + OAuth flow | `THINK_CLIENT_ID` / `THINK_CLIENT_SECRET` (regenerate the expired one-time-secret link) + callback whitelist |

None of the three requires a code change to plug in — the moment the env vars are set on the server, both OAuth integrations start working. Mews already works.

---

## What's already built for Cloudbeds + Think

All non-vendor-specific code is in place. Adding either PMS after this point is an env var change + a Supabase migration (which is already applied):

**Database:**
- `pms_type` enum extended to include `'think'` (Cloudbeds was already present). See `99_supabase_migration_pms_types_v1.sql`.
- No table changes — both use the same `pms_connections` + Vault-backed `pms_connection_secrets` shape that Mews uses.

**Server code:**
- `src/lib/pms/registry.ts` — central metadata (auth URLs, scopes, required env vars, callback URL) for all three PMSes.
- `src/lib/pms/oauth-state.ts` — HMAC-signed `state` parameter (CSRF protection for the OAuth redirect).
- `src/lib/pms/oauth-flow.ts` — shared `buildAuthorizeRedirect` + `handleOAuthCallback` used by both vendors. Handles token exchange, Vault storage via `pms_secret_set`, `pms_connections` upsert, audit log write, and success redirect back to the hotel detail page.

**API routes:**
- `POST /api/pms/cloudbeds/connect?hotelId=...` → redirects to Cloudbeds authorize URL
- `GET /api/pms/cloudbeds/callback` → exchanges code, stores tokens, redirects to `/admin/hotels/[id]`
- `POST /api/pms/think/connect?hotelId=...` → same shape for Think
- `GET /api/pms/think/callback` → same
- `GET /api/admin/pms/status` → reports which PMSes are configured (used by the UI to render "Ready" vs "Missing env" chips)

**UI:**
- The create-hotel wizard now has a "PMS" chooser at step 3 with all three vendors + "Skip for now."
- The hotel detail page's PMS card shows all three PMSes as options when none is connected. Each shows either "Ready to connect" (env vars set) or "Missing env: X, Y" (still waiting on creds). Clicking Cloudbeds or Think initiates the OAuth flow.

**Vault secret shape** stored per PMS:

```jsonc
// Mews (unchanged)
{ "clientToken": "...", "accessToken": "...", "enterpriseId": "...", "env": "demo" }

// Cloudbeds / Think (written by the OAuth callback)
{
  "accessToken": "...",
  "refreshToken": "...",
  "tokenType": "Bearer",
  "scope": "read:rate write:rate ...",
  "expiresAt": "2026-07-10T12:00:00Z"
}
```

The `resolve-credentials.ts` module will need a small update to refresh Cloudbeds/Think tokens on expiry before the sync runs — that's the next code change once creds arrive.

---

## Env vars — copy this block into `.env.local` when creds are in hand

```bash
# ---- Cloudbeds ----
CLOUDBEDS_CLIENT_ID=modern_hospitality_solutions_lSNvTm89iEusYGMjb4feB0DX
CLOUDBEDS_CLIENT_SECRET=<paste-from-vendor>
# Optional override if Cloudbeds sandbox moves off the standard host:
# CLOUDBEDS_AUTHORIZE_BASE_URL=https://hotels.cloudbeds.com

# ---- Think Reservations ----
THINK_CLIENT_ID=<paste-from-vendor>
THINK_CLIENT_SECRET=<paste-from-vendor>
# These are the Think defaults from their onboarding email:
# THINK_AUTHORIZE_URL=https://auth.thinkreservations.com/authorize
# THINK_TOKEN_URL=https://auth.thinkreservations.com/oauth/token
# THINK_API_AUDIENCE=https://api.thinkreservations.com/

# ---- OAuth state signing (both) ----
# Any 32+ byte hex string. Generate:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
PMS_OAUTH_STATE_SECRET=<generate-once-per-environment>
```

On Vercel: same vars in Project Settings → Environment Variables (Production + Preview).

`PMS_OAUTH_STATE_SECRET` is server-only — no `NEXT_PUBLIC_` prefix. If you rotate it, in-flight OAuth flows fail with "State expired" and users have to click Connect again (harmless).

---

## Callback URLs to send vendors

These are what Jake asked for. Send these to Think + Cloudbeds for whitelisting:

**Cloudbeds redirect URIs:**
```
http://localhost:3000/api/pms/cloudbeds/callback
https://maya-rms.com/api/pms/cloudbeds/callback
```

**Think Reservations redirect URIs:**
```
http://localhost:3000/api/pms/think/callback
https://maya-rms.com/api/pms/think/callback
```

Same shape for both. Only the `pms/{name}/` segment differs.

Both are derived at runtime, not hardcoded: `pmsCallbackUrl()` in
`src/lib/pms/registry.ts` builds `${MAYA_INVITE_REDIRECT_BASE}/api/pms/{type}/callback`
and throws if that env var is unset. Production has it set to `https://maya-rms.com/`.
Cloudbeds Flow A (Marketplace) and Flow B (Connect App) share the same URI and
the same route — the callback tells them apart by whether `state` is present —
so only the one entry needs registering.

**Cloudbeds App Details → login page URL:** `https://maya-rms.com/login`
(that page already handles the `?claim=` and `?reconnected=1` Flow A lands on).

---

## Cloudbeds OAuth scopes

The list MAYA requests, verbatim from `src/lib/pms/registry.ts`:

```
read:reservation  write:reservation  read:room  read:rate  write:rate  read:hotel  read:taxesAndFees
```

`read:taxesAndFees` was added 2026-09-09. Cloudbeds spells it in full camelCase —
NOT the singularized `read:tax` the neighbouring scopes would suggest.

Two things about scopes that are easy to get wrong:

1. **A Marketplace (Flow A) connection never passes through MAYA's authorize
   URL**, so this array is not sent for it at all. What a property is asked to
   grant comes entirely from the app's configuration on the Cloudbeds side. The
   sandbox hotel connected via Flow A (`platform_audit_events.detail.via =
   'marketplace_flow_a'`), which is why editing this array alone does nothing
   for it.
2. **A refresh can never widen a grant.** `oauth-credentials.ts` replays the
   stored scope, which RFC 6749 §6 only allows as a subset of the original.
   Adding a scope here reaches existing connections only after a re-authorization.

Also worth knowing: **Cloudbeds does not return a `scope` field on its token
response** (verified against the sandbox secret 2026-09-09), so the stored
`scope` key is absent for Cloudbeds and the refresh path sends none. The example
secret shape above shows a `scope` value because Think does return one.

---

## Cloudbeds API hosts — settled

Three different surfaces, which is where the confusion comes from:

| Surface | Host |
|---|---|
| OAuth authorize + token | `hotels.cloudbeds.com/api/v1.3/oauth` and `/api/v1.3/access_token` (no `/oauth` on the token path) |
| Classic PMS data API | `/api/v1.2/<method>` — works identically on **both** `api.` and `hotels.` |
| New resource API (rate writes) | `api.cloudbeds.com/<resource>/v1/...` |

`scripts/cb-host-compare.mts` runs every mandatory RMS method against both hosts
with a live token. On 2026-09-09 they answered identically: same statuses, same
row counts, same scope error on `getTaxesAndFees`. There is no ambiguity to
resolve with Cloudbeds — re-run the script if that ever needs re-proving.

`getUserInfo` is **gone**: 404 on both hosts across v1.1/v1.2/v1.3. Property
discovery uses `getHotels`.

---

## Smoke test order once creds arrive

Do these in order in the SQL Editor / app:

1. **Apply `99_supabase_migration_pms_types_v1.sql`** if you haven't already.
2. **Set env vars** for whichever PMS's creds arrived first, plus `PMS_OAUTH_STATE_SECRET`.
3. **Restart `npm run dev`** (env vars only read at process start).
4. **Sign into `/admin`** as platform_admin, open any hotel's detail page. The PMS card should show the new PMS as "Ready to connect" — if it says "Missing env", the vars aren't loaded.
5. **Click "Connect Cloudbeds"** (or Think). You should be redirected to the vendor's login. Sign in with the sandbox account, authorize.
6. **Land back on `/admin/hotels/[id]?pmsConnected=1`.** The PMS card now shows the vendor as connected. Verify:
   ```sql
   select hotel_id, pms_type, status, last_tested_at
   from public.pms_connections where hotel_id = '<hotel-uuid>';
   -- pms_type should be 'cloudbeds' or 'think', status = 'connected'

   select public.pms_secret_get('<hotel-uuid>'::uuid, 'cloudbeds'::pms_type);
   -- should return the Vault-decrypted { accessToken, refreshToken, expiresAt, ... }
   ```
7. **Check `platform_audit_events`** — you should see a `pms.connected` row with `detail.via = 'oauth'`.

If any of these fail, the callback page renders a self-contained HTML error page with the exact failure reason (state mismatch, token endpoint error, etc.) — no debugger needed.

---

## Refresh flow (IMPLEMENTED — see supabase/functions/_shared/pms/oauth-credentials.ts)

Cloudbeds and Think access tokens live ~1h. `resolve-credentials.ts` currently just returns the stored secret. Once real creds are in and a first successful sync happens, we'll add:

```ts
// pseudocode
if (secret.expiresAt && new Date(secret.expiresAt) < new Date(Date.now() + 60_000)) {
  const refreshed = await refreshTokens(pmsType, secret.refreshToken);
  await supabase.rpc("pms_secret_set", { p_hotel_id, p_pms_type: pmsType, p_secret: refreshed });
  return refreshed;
}
```

That's a ~20-line addition and can land in the same PR as the first Cloudbeds sync.

---

## Files added / changed for this stub work

**SQL:**
- `MAYA/99_supabase_migration_pms_types_v1.sql` — new
- `MAYA/01_supabase_base_schema.sql`, `MAYA/02_supabase_schema.sql` — added `think` to the `pms_type` enum

**Next.js:**
- `.env.example` — added Cloudbeds, Think, and `PMS_OAUTH_STATE_SECRET` var stubs with instructions
- `src/lib/pms/registry.ts` — new
- `src/lib/pms/oauth-state.ts` — new
- `src/lib/pms/oauth-flow.ts` — new
- `src/app/api/pms/cloudbeds/connect/route.ts` — new
- `src/app/api/pms/cloudbeds/callback/route.ts` — new
- `src/app/api/pms/think/connect/route.ts` — new
- `src/app/api/pms/think/callback/route.ts` — new
- `src/app/api/admin/pms/status/route.ts` — new
- `src/lib/admin/types.ts` — added `"think"` to `PmsType` union
- `src/components/admin/hotel-pms-card.tsx` — rewritten to support all three PMSes
- `src/components/admin/create-hotel-wizard.tsx` — PMS chooser added to step 3
- `src/app/admin/hotels/[hotelId]/page.tsx` — passes `pmsStatuses` to the card

Nothing about the Mews code path changed.
