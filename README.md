# MAYA Workspace

This repository currently contains two application paths during migration:

- `maya-rms/` - Next.js + Supabase application (current primary path)
- `shared/legacy-python/` - legacy Python implementation (kept for reference and parity checks)

Database scripts for Supabase live in this folder (`MAYA/`) with numeric run-order prefixes.

## Repository Layout

- `maya-rms/`
  - React/Next app
  - Supabase SSR auth/session wiring
  - Current UI and API implementation
  - `maya-rms/supabase/` — Edge Functions (e.g. **`mews-scheduled-sync`**) and CLI config; run `supabase` commands from `maya-rms/`
- `shared/legacy-python/`
  - Original Python ETL/rules/metrics/scheduler/dashboard
- `00_supabase_reset_dev.sql` (optional)
  - Truncate or drop MAYA `public` tables for a dev reset; see file header
- `01_supabase_base_schema.sql`
  - Core schema objects (tables/enums/indexes)
- `02_supabase_schema.sql`
  - Full schema + RLS policies, triggers, helper functions
- `03_supabase_seed.sql`
  - Hotel + `hotel_memberships` bootstrap data (no organizations)
- `04_supabase_demo_data.sql`
  - Synthetic reservations + occupancy metrics
- `99_supabase_migration_rules_engine_v1.sql` (legacy upgrades only)
  - Incremental migration for DBs created before rules-engine v1; skip on fresh 01+02 loads
- `99_supabase_migration_pms_secrets_v1.sql` (legacy upgrades only)
  - Moves PMS credentials from `pms_connections.credentials_encrypted` into Supabase Vault, accessed through SECURITY DEFINER RPCs (`pms_secret_get` / `pms_secret_set` / `pms_secret_delete`); skip on fresh 01+02 loads
- `99_supabase_migration_command_center_v1.sql` (legacy upgrades only)
  - Adds the Command Center DB foundation: `app_roles` + `is_platform_admin()` helper (platform admins bypass hotel-scoped RLS), `pending_memberships` + auto-accept trigger on `auth.users`, and `platform_audit_events`; skip on fresh 01+02 loads
- `supabase_dev_full_dump.sql`
  - Placeholder for a full `public` schema dump; generate with `scripts/export-dev-full-dump.sh`

## Quick Start (Next.js App)

From workspace root:

```bash
cd maya-rms
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Production checks:

```bash
cd maya-rms
npm run lint
npm run build
```

## Supabase Setup Order

If you previously applied the older schema with `organizations` and `organization_id` on `hotels`, run **`00_supabase_reset_dev.sql`** (Section B) or use a fresh Supabase project before re-applying DDL.

Run these in Supabase SQL Editor in this order:

| Step | File | When |
|------|------|------|
| (optional) | `00_supabase_reset_dev.sql` | Truncate data (A) or drop + enums (B) before rebuilding |
| 1 | `01_supabase_base_schema.sql` | Always first for DDL |
| 2 | `02_supabase_schema.sql` | Always second (policies, triggers, engine tables) |
| (optional) | `99_supabase_migration_rules_engine_v1.sql` | Only for **existing** old DBs; skip if 01+02 are a fresh load from this repo |
| (optional) | `99_supabase_migration_pms_secrets_v1.sql` | Only for **existing** DBs created before PMS Secrets v1; skip on fresh 01+02 loads |
| (optional) | `99_supabase_migration_command_center_v1.sql` | Only for **existing** DBs created before Command Center v1; skip on fresh 01+02 loads. After applying, grant yourself platform admin: `insert into app_roles (user_id, role) values ('<auth.users-uuid>', 'platform_admin');` |
| 3 | `03_supabase_seed.sql` | After auth user exists; edit emails in the script |
| 4 | `04_supabase_demo_data.sql` | Optional synthetic calendar/metrics load |

Optional: replace `supabase_dev_full_dump.sql` with `./scripts/export-dev-full-dump.sh` (requires `DATABASE_URL` and `pg_dump`) to snapshot all `public` data for dev.

After seeding/demo data:

- Sign in via `maya-rms` (`/login`)
- Verify your user has memberships
- Refresh app and validate tenant-scoped data

## Legacy Python Commands

Run from the legacy folder:

```bash
cd shared/legacy-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 main.py
```

Run tests:

```bash
cd shared/legacy-python
python -m pytest tests/ -v
```

Run legacy local dashboard:

```bash
cd shared/legacy-python
python3 -m tools.local_gui
```

## Notes

- Tenant isolation is enforced through Supabase RLS and memberships.
- `auth.users` stores identity; membership tables define access.
- During migration, both app paths are intentionally kept in one workspace.
