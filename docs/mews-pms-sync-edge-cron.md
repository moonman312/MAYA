# Mews PMS sync — Supabase Edge Function + `pg_cron`

**Step-by-step Dashboard + local vs deployed:** [`supabase-mews-sync-manual-setup.md`](./supabase-mews-sync-manual-setup.md)

Background sync runs **in Supabase**: **`pg_cron`** invokes the Edge Function **`mews-scheduled-sync`**, which uses the **service role** to run the same pipeline as **`POST /api/pms/mews/sync`** for **every hotel** with a `pms_connections` row where `pms_type = 'mews'`.

## Repo layout (implemented)

| Path | Role |
|------|------|
| `maya-rms/supabase/functions/mews-scheduled-sync/index.ts` | Cron entrypoint: validates secret, lists hotels, calls `runMewsSyncForHotel` |
| `maya-rms/supabase/functions/_shared/mews/*` | Shared Mews client, ETL, credentials, **`sync-hotel.ts`** (`runMewsSyncForHotel`) |
| `maya-rms/src/lib/mews/*.ts` | Thin re-exports into the Next app (same modules) |
| `maya-rms/src/app/api/pms/mews/sync/route.ts` | Authenticated single-hotel sync → **`runMewsSyncForHotel`** |
| `maya-rms/supabase/config.toml` | `[functions.mews-scheduled-sync] verify_jwt = false` |
| `maya-rms/supabase/cron/mews-sync-every-5-min.sql.example` | Copy/paste Vault + `cron.schedule` template |

`runMewsSyncForHotel` uses **`mwsEnv()`** so the same **`MEWS_*` / `MAYA_SYNC_*` / `MAYA_FETCH_*`** secrets work in **Edge** (set under Edge Function secrets) and **Next** (`.env.local`).

## Security model

- **Edge** uses **`SUPABASE_SERVICE_ROLE_KEY`** → bypasses RLS (normal for server ETL).
- **`verify_jwt = false`** for this function; require **`MEWS_CRON_SECRET`** in the Edge environment and send the same value as header **`x-mews-cron-secret`** from `pg_net` (stored in Vault). Without the secret, the function returns **401**.
- Never expose the service role or cron secret in client bundles or git.

## Deploy the function

From **`maya-rms/`** (where `supabase/` lives):

```bash
cd maya-rms
npx supabase@latest login
npx supabase@latest link --project-ref <your-project-ref>
npx supabase@latest functions deploy mews-scheduled-sync
```

If the CLI is installed globally (`brew install supabase/tap/supabase`), use `supabase` instead of `npx supabase@latest`. See [`supabase-mews-sync-manual-setup.md`](./supabase-mews-sync-manual-setup.md#install-the-supabase-cli) if `supabase` is not found.

Edge **Secrets** (Dashboard → Edge Functions):

- `MEWS_CRON_SECRET` — long random string; match Vault + cron header below  
- `SUPABASE_SERVICE_ROLE_KEY` — confirm present  
- Optional: `MEWS_ENV`, `MEWS_BASE_URL`, `MEWS_CLIENT_NAME`, `MAYA_SYNC_DAYS_BACK`, `MAYA_SYNC_DAYS_FORWARD`, `MAYA_FETCH_START` / `MAYA_FETCH_END`, `MEWS_RESERVATIONS_WINDOW_HOURS`, global `MEWS_CLIENT_TOKEN` / `MEWS_ACCESS_TOKEN` (same semantics as Next)

## Database: Vault + `pg_cron` every 5 minutes

Enable extensions: **`pg_cron`**, **`pg_net`**, Vault.

Store secrets (names must match what you use in SQL):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<same-as-MEWS_CRON_SECRET>', 'mews_cron_secret');
```

Schedule (every 5 minutes):

```sql
select cron.schedule(
  'mews-sync-every-5-min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/mews-scheduled-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mews-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'mews_cron_secret')
    ),
    body := jsonb_build_object('scheduled_at', now())
  ) as request_id;
  $$
);
```

Inspect / remove:

```sql
select * from cron.job;
-- select cron.unschedule(jobid) from cron.job where jobname = 'mews-sync-every-5-min';
```

Official reference: [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).

## Verify

```bash
cd maya-rms
npx supabase@latest functions invoke mews-scheduled-sync \
  --header "x-mews-cron-secret: $MEWS_CRON_SECRET"
```

Then check **`pms_connections.last_sync_at`** and app calendar data.

## Limits & ops

- Edge [runtime limits](https://supabase.com/docs/guides/functions/limits) (e.g. 150s Free / 400s Pro). Many hotels run **sequentially**; narrow the fetch window or increase the cron interval if you hit timeouts.
- Overlapping invocations: if sync &gt; 5 minutes, add a lock or slow the schedule.
- Response body includes **`results`** per `hotelId` (success or **`error`** string).

## Manual sync in the app

The dashboard **Sync reservations** button remains; it uses the user-scoped client and **one active hotel**, while cron syncs **all** Mews-connected hotels with the service role.
