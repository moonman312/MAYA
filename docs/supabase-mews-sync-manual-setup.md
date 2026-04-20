# Manual setup: Mews scheduled sync in Supabase (dashboard + local vs deployed)

This guide walks through **setting up the `mews-scheduled-sync` Edge Function and `pg_cron` job** using the **Supabase Dashboard** (including the **Edge Functions** screen you see with *Via Editor*, *AI Assistant*, and *Via CLI*). It also explains how **local development** differs from **deployed (hosted)** behavior.

For architecture and file locations in git, see [`mews-pms-sync-edge-cron.md`](./mews-pms-sync-edge-cron.md).

---

## Install the Supabase CLI

If `supabase: command not found`:

- **Without a global install (works everywhere):** from `maya-rms/`, use **`npx`**:
  - `npx supabase@latest login`
  - `npx supabase@latest link --project-ref <ref>`
  - `npx supabase@latest functions deploy mews-scheduled-sync`
- **macOS + Homebrew:** `brew install supabase/tap/supabase` — if this errors on **outdated Command Line Tools**, update them (System Settings → Software Update, or `xcode-select --install`) and retry, or keep using **`npx`** above.

---

## Local vs deployed — what actually changes

| Topic | **Local** (your machine) | **Deployed** (Supabase hosted project) |
|--------|---------------------------|------------------------------------------|
| **Where the function runs** | Docker (e.g. `supabase start`) or `supabase functions serve` — Edge runtime on localhost | Supabase’s managed Edge infrastructure (`https://<project-ref>.supabase.co/functions/v1/...`) |
| **Which database** | Local Postgres from `supabase start`, or **linked** remote DB if you point env at it | Your **cloud** Postgres for that project |
| **Secrets** | Shell env vars, or `.env` files used by CLI — **not** the Dashboard “Secrets” UI | **Dashboard → Edge Functions → [your function] → Secrets** (and Vault for `pg_cron`) |
| **Cron (`pg_cron`)** | Runs only if you use a **local** stack that includes `pg_cron` / `pg_net` and you schedule jobs there; many teams **skip local cron** and test invokes manually | **SQL Editor** on the hosted project: Vault + `cron.schedule` → `net.http_post` to **production** function URL |
| **Mews API** | Same Mews endpoints; credentials from **local** env or from **same** `pms_connections` rows if you sync against remote DB | Credentials from **`pms_connections`** (and Edge secrets for global `MEWS_*` fallback) |
| **Next.js app** | `maya-rms` on `localhost`; manual sync uses **your** session | Production URL; same API routes, different env |

**Important:** “Local” does **not** mean the cron magically runs in the cloud. A schedule created in the **hosted** SQL Editor fires against the **hosted** function URL. Local cron is optional and is usually for advanced testing.

---

## What you are wiring up (end state)

1. **Edge Function** `mews-scheduled-sync` is **deployed** to your Supabase project (code comes from this repo).
2. **Edge secrets** include at least `MEWS_CRON_SECRET` (and usually Mews-related vars aligned with your Next app).
3. **Database:** extensions **`pg_cron`** + **`pg_net`** (+ Vault), Vault entries for `project_url` and `mews_cron_secret`, and a **`cron.schedule`** job every 5 minutes that POSTs to the function with header **`x-mews-cron-secret`**.

---

## Part A — Edge Functions in the Dashboard (your screenshot)

On **Edge Functions**, Supabase shows three ways to start:

### A1. “Via Editor” (browser)

- **What it is:** Create or edit a function **only in the browser**. You can download to disk later.
- **When to use:** Quick experiments, hello-world, or small functions **not** yet in git.
- **For MAYA:** The real implementation lives in **`maya-rms/supabase/functions/`** with **`_shared`** imports. Recreating that **by hand in the Editor** is error-prone and will **drift** from the repo. Prefer **CLI deploy** (below) so production matches git.
- **If you still use the Editor:** You would paste the contents of `mews-scheduled-sync/index.ts` and duplicate shared modules — **not recommended** long term.

### A2. “AI Assistant”

- **What it is:** Generates starter code in the dashboard.
- **For MAYA:** Same caveat as the Editor — use repo + CLI for the canonical `mews-scheduled-sync` implementation.

### A3. “Via CLI” (recommended for this repo)

- **What it is:** Develop in your repo, then **`supabase functions deploy`** pushes the function to the **linked** hosted project.
- **This matches “deployed”**: the live URL is `https://<project-ref>.supabase.co/functions/v1/mews-scheduled-sync`.

**CLI steps (from your laptop):**

```bash
cd maya-rms
npx supabase@latest login
npx supabase@latest link --project-ref <your-project-ref>   # once per machine/project
npx supabase@latest functions deploy mews-scheduled-sync
```
(If you installed the CLI globally, drop `npx supabase@latest` and run `supabase` instead.)

After deploy, refresh **Edge Functions** in the dashboard — you should see **`mews-scheduled-sync`** listed (you do **not** need to click “Deploy a new function” → Editor if you deployed via CLI).

---

## Part B — Secrets (hosted / deployed)

Path: **Project Dashboard → Edge Functions → `mews-scheduled-sync` → Secrets** (exact labels may vary slightly by Supabase version).

Set at minimum:

| Secret | Purpose |
|--------|---------|
| `MEWS_CRON_SECRET` | Long random string. The function checks header `x-mews-cron-secret` against this value. **Must match** the Vault secret used in `pg_net` (see Part D). |
| `SUPABASE_SERVICE_ROLE_KEY` | Often auto-injected on hosted Supabase; confirm it exists for this function. Used to read `pms_connections` and upsert reservations (bypasses RLS). |

Optional (mirror your Next `.env.local` / production env so behavior matches manual sync):

- `MEWS_ENV`, `MEWS_BASE_URL`, `MEWS_CLIENT_NAME`
- `MAYA_SYNC_DAYS_BACK`, `MAYA_SYNC_DAYS_FORWARD`, `MAYA_FETCH_START`, `MAYA_FETCH_END`
- `MEWS_RESERVATIONS_WINDOW_HOURS` (or `MEWS_RESERVATIONS_WINDOW_DAYS`)
- `MEWS_CLIENT_TOKEN`, `MEWS_ACCESS_TOKEN`, `MEWS_ENTERPRISE_ID` (only if you rely on env fallback instead of per-hotel `pms_connections`)

**Local note:** When you run `supabase functions serve mews-scheduled-sync`, you typically export the same variables in your terminal or use a local `.env` consumed by the CLI — the **Dashboard Secrets** apply to **deployed** invocations only.

---

## Part C — Database extensions (`pg_cron`, `pg_net`, Vault)

### Why you might not see `pg_net` in the Extensions list

The dashboard search box does **not** always list every installable extension, and naming varies (**`pg_net`**, **`pgnet`**, “async HTTP”). That does **not** mean the extension is unavailable.

**Preferred fix:** enable extensions with SQL in the **SQL Editor** (runs as a privileged database role on hosted Supabase). This matches the [official `pg_net` docs](https://supabase.com/docs/guides/database/extensions/pg_net).

**C1 — Enable `pg_net` (creates the `net` schema and `net.http_post`)**

Run:

```sql
create extension if not exists pg_net;
```

Then confirm:

```sql
select extname from pg_extension where extname = 'pg_net';
-- should return one row

select pronamespace::regnamespace, proname
from pg_proc
where proname = 'http_post' and pronamespace = 'net'::regnamespace;
-- should show net.http_post
```

If **`create extension`** errors with **permission denied** or **extension "pg_net" is not available**, your project or Postgres version may restrict it — check [Supabase `pg_net` documentation](https://supabase.com/docs/guides/database/extensions/pg_net) or support. There is no supported substitute in this guide for **`net.http_post`** + **`x-mews-cron-secret`** without `pg_net` (the older synchronous **`http`** extension uses a different API and is not a drop-in replacement here).

**C2 — `pg_cron`**

Enable from the dashboard if listed, or:

```sql
create extension if not exists pg_cron;
```

**C3 — Vault** (for `vault.create_secret` / `vault.decrypted_secrets`)

Often available as **Vault** or **`supabase_vault`** in extensions. If `vault.create_secret` already works for you, skip this. Otherwise enable whatever your project lists for Vault, or follow Supabase Vault docs.

**Verify all three:**

```sql
select extname from pg_extension where extname in ('pg_cron', 'pg_net');
```

---

## Part D — Vault + cron schedule (Dashboard Cron UI *or* SQL Editor)

### How this fits together

- **Integrations → Cron → Jobs** (your screenshot) is the **dashboard for `pg_cron`**. Creating a job there is equivalent to running `cron.schedule(...)` in SQL: it registers a recurring job in Postgres.
- **`pg_net`** must be enabled: the job issues an HTTP POST via **`net.http_post`** to your Edge Function URL.
- **Vault (beta in the UI)** is the productized face of the **`vault` Postgres extension**. You still need **named secrets** (`project_url`, `mews_cron_secret`) available to SQL as in our examples. Easiest path that matches this repo: run **`vault.create_secret`** in the **SQL Editor** once. If you prefer the beta Vault UI to create secrets, use the **same names** (`project_url`, `mews_cron_secret`) so the SQL below keeps working.

### D1 — One-time: store secrets in Vault (SQL Editor)

Path: **SQL Editor → New query**.

Replace placeholders:

- `<project-ref>` — from Project Settings (URL `https://<project-ref>.supabase.co`).
- `<cron-secret>` — same string as Edge secret **`MEWS_CRON_SECRET`**.

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<cron-secret>', 'mews_cron_secret');
```

Run once per project. If a secret already exists with that name, use Vault / SQL to update it per Supabase docs instead of duplicating names.

### D2 — Create the cron job (pick one path)

**Why not only “Edge Function” in the form?**  
`mews-scheduled-sync` expects a custom header **`x-mews-cron-secret`**. Presets that only send the default **`Authorization: Bearer <anon key>`** are **not enough** unless you change the function. The reliable approach is a job that runs SQL calling **`net.http_post`** with that header (below).

#### Path A — Dashboard: **Integrations → Cron → Jobs → Create job** (recommended if you like the UI)

Official flow: [Cron quickstart — Schedule a job](https://supabase.com/docs/guides/cron/quickstart).

1. Open **Integrations → Cron → Jobs** (or **Overview** then switch to **Jobs**).
2. Click **Create job**.
3. **Name:** `mews-sync-every-5-min`  
   - Job names are **case-sensitive** and **cannot be renamed** after creation; creating another job with the same name **overwrites** the first.
4. **Schedule:** `*/5 * * * *` (every 5 minutes).  
   - Optional: some projects support intervals like `30 seconds` on newer Postgres; use 5-minute cron unless you need faster runs.
5. **Job type / command:** Choose the option that lets you run a **SQL snippet** (or raw SQL body) equivalent to `pg_cron`. Paste **exactly** the inner scheduled command — the `select net.http_post(...)` block — **or** the full `select cron.schedule(...)` shown in Path B, depending on what the form expects:
   - If the UI asks only for the **statement to run** (no wrapper), use the **`$$ ... $$`** body from Path B (the part inside `cron.schedule`’s third argument).
   - If the UI wants the **full** `cron.schedule` call, use Path B as-is in one field.
6. Save / activate the job. Use **History** on the job row to confirm runs.

If the form offers **“Supabase Edge Function”** without custom headers, **do not use it** for this function unless you add **`x-mews-cron-secret`** another way; use the **SQL / HTTP with headers** approach instead.

#### Path B — **SQL Editor only** (same result as Path A)

Run the full schedule statement once:

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

Optional: set `timeout_milliseconds` on `net.http_post` if your sync is slow (see [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)).

### D3 — Inspect, pause, or delete the job

- **Dashboard:** **Jobs** table → toggle **Active**, **Edit**, **History**, or **Delete** (confirm name).
- **SQL:**

```sql
select * from cron.job;
-- select cron.unschedule('mews-sync-every-5-min');
```

Use **`cron.unschedule('jobname')`** with the **string name**, not `jobid`, unless your Postgres version/docs specify otherwise.

Repo copy of the schedule body: `maya-rms/supabase/cron/mews-sync-every-5-min.sql.example`.

---

## Part E — Verify (deployed)

1. **Dashboard → Edge Functions → `mews-scheduled-sync` → Logs** (or **Invocations**), after a few minutes.
2. **CLI invoke** (uses **deployed** function if project is linked):

   ```bash
   cd maya-rms
   npx supabase@latest functions invoke mews-scheduled-sync \
     --header "x-mews-cron-secret: YOUR_MEWS_CRON_SECRET"
   ```

3. In the database, check **`pms_connections.last_sync_at`** for Mews rows.
4. In the app, confirm calendar/reservation data updates without pressing **Sync** in the PMS tab.

---

## Part F — Local development workflow (optional)

Typical flow for **changing** the function without touching production until you deploy:

1. **`supabase start`** (if you use the full local stack) — gives local Postgres + local Studio.
2. **`supabase functions serve mews-scheduled-sync`** — serves the function locally; set env vars for `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MEWS_CRON_SECRET`, etc. Point `SUPABASE_URL` at **local** or **remote** DB depending on what you want to test.
3. Call **`http://localhost:54321/functions/v1/mews-scheduled-sync`** (default port may differ; check CLI output) with header **`x-mews-cron-secret`**.
4. When satisfied, **`supabase functions deploy mews-scheduled-sync`** to update **hosted** behavior.

**Cron locally:** Most developers do **not** duplicate the `pg_cron` job on local Docker; they rely on **manual invoke** or a temporary script. The **authoritative** schedule for production remains the SQL in Part D on the **hosted** project.

---

## Checklist summary

**Deployed (production-style) setup**

- [ ] Code deployed: `supabase functions deploy mews-scheduled-sync` from `maya-rms/`
- [ ] Edge secrets: `MEWS_CRON_SECRET` (+ optional Mews vars), service role present
- [ ] Extensions: `pg_cron`, `pg_net` (use `create extension if not exists pg_net;` if missing from UI), Vault
- [ ] Vault: `project_url`, `mews_cron_secret`
- [ ] `cron.schedule` for `*/5 * * * *` with `x-mews-cron-secret` header
- [ ] Verify logs + `last_sync_at` + app data

**Local (developer machine)**

- [ ] `supabase functions serve` + env vars + manual HTTP invoke (cron optional)
- [ ] Deploy via CLI when ready; Dashboard Secrets apply only after deploy

---

## Is this “software architecture” or “manual Supabase work”?

- **Architecture / code** is in **git** (`maya-rms/supabase/functions/...`).
- **Turning it on** in a real Supabase project is **operational**: CLI deploy, Dashboard secrets, and SQL Editor for extensions + Vault + `pg_cron`. Nothing in git auto-runs those steps against your hosted project until **you** (or CI) run them.

If you later want more **infra-as-code**, you can add versioned SQL migrations under `maya-rms/supabase/migrations/` that enable extensions and document the cron job — you would still **apply** them with `supabase db push` or the SQL Editor.
