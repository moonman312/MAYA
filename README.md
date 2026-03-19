# MAYA Workspace

This repository currently contains two application paths during migration:

- `maya-rms/` - Next.js + Supabase application (current primary path)
- `shared/legacy-python/` - legacy Python implementation (kept for reference and parity checks)

Database scripts for Supabase live at the workspace root.

## Repository Layout

- `maya-rms/`
  - React/Next app
  - Supabase SSR auth/session wiring
  - Current UI and API implementation
- `shared/legacy-python/`
  - Original Python ETL/rules/metrics/scheduler/dashboard
- `supabase_base_schema.sql`
  - Core schema objects (tables/enums/indexes)
- `supabase_schema.sql`
  - Full schema + RLS policies/functions
- `supabase_seed.sql`
  - Organization/hotel/membership bootstrap data
- `supabase_demo_data.sql`
  - Synthetic reservations + occupancy metrics

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

Run these scripts in Supabase SQL Editor in this exact order:

1. `supabase_base_schema.sql`
2. `supabase_schema.sql`
3. `supabase_seed.sql` (update emails first)
4. `supabase_demo_data.sql`

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
