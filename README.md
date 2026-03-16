<p align="center">
  <img src="https://img.shields.io/badge/python-3.9+-3776ab?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/PostgreSQL-15+-4169e1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="MIT License">
  <img src="https://img.shields.io/badge/PMS-Mews_API-f59e0b?style=for-the-badge" alt="Mews Connector API">
</p>

<h1 align="center">
  <br>
  MA<span style="color:#3b82f6">YA</span>
  <br>
  <sub>Machine Assisted Yield Automation</sub>
</h1>

<p align="center">
  <strong>An intelligent, multi-hotel revenue management system that automates dynamic pricing through real-time occupancy monitoring, rule-based rate optimization, and seamless PMS integration.</strong>
</p>

---

## Overview

MAYA connects to your Property Management System (currently [Mews](https://www.mews.com/)), continuously monitors reservation data, and automatically adjusts room rates based on configurable pricing rules. It's designed for hotel groups managing multiple properties from a single platform.

### Key Capabilities

| Feature | Description |
|---------|-------------|
| **Multi-Hotel Management** | Manage unlimited properties from one dashboard with per-hotel rule isolation |
| **Dynamic Pricing Engine** | JSON-based rules engine with multi-condition logic and stacked rule evaluation |
| **Real-Time Occupancy Tracking** | Per-room-type occupancy monitoring with demand-based rate calculations |
| **Automated Rate Push-Back** | Adjusted rates are pushed directly back to the PMS via API |
| **Audit Trail** | Every rate change is logged with before/after values for compliance |
| **Interactive Dashboard** | Browser-based SPA with calendar heat-maps, rule management, and rate simulation |
| **Scheduled Batch Processing** | APScheduler runs the full pipeline every 5 minutes (configurable) |

---

## Architecture

```
                    +─────────────────────────────────────────+
                    │              MAYA Platform              │
                    +─────────────────────────────────────────+
                    │                                         │
   ┌────────┐       │  ┌──────────┐   ┌──────────┐          │
   │ Mews   │◄─────►│  │   API    │──►│   ETL    │          │
   │  API   │       │  │  Client  │   │  Layer   │          │
   └────────┘       │  └──────────┘   └────┬─────┘          │
                    │                      │                 │
                    │                 ┌────▼─────┐           │
                    │                 │ Metrics  │           │
                    │                 │  Engine  │           │
                    │                 └────┬─────┘           │
                    │                      │                 │
                    │  ┌──────────┐   ┌────▼─────┐          │
                    │  │  Audit   │◄──│  Rules   │          │
                    │  │   Log    │   │  Engine  │          │
                    │  └──────────┘   └──────────┘          │
                    │                                         │
   ┌────────┐       │  ┌──────────┐   ┌──────────┐          │
   │Browser │◄─────►│  │   Web    │──►│Scheduler │          │
   │  SPA   │       │  │  Server  │   │(APSched) │          │
   └────────┘       │  └──────────┘   └──────────┘          │
                    │                                         │
                    │         ┌──────────────┐               │
                    │         │  PostgreSQL   │               │
                    │         │  (multi-      │               │
                    │         │   tenant)     │               │
                    │         └──────────────┘               │
                    +─────────────────────────────────────────+
```

---

## Quick Start

### Prerequisites

- **Python 3.9+**
- **PostgreSQL 13+** (running locally or remotely)

### 1. Clone & Install

```bash
git clone https://github.com/your-org/maya.git
cd maya
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure the Database

Create a PostgreSQL database named `maya`:

```bash
createdb maya
```

The default connection string expects:
```
dbname=maya user=postgres password=postgres host=localhost port=5432
```

Modify `config.py` if your setup differs.

### 3. Launch the Dashboard (Demo Mode)

```bash
python3 -m tools.local_gui
```

This opens a browser-based dashboard with **demo data** — no PMS credentials needed. Perfect for exploring the UI, testing rules, and understanding the system.

### 4. Run the Full Pipeline (Production Mode)

```bash
python3 main.py
```

This will:
1. Create the database schema
2. Seed a demo hotel (if empty)
3. Fetch reservations from the Mews API
4. Run the ETL + metrics + rules pipeline
5. Start the APScheduler for recurring batch processing

---

## Project Structure

```
MAYA/
├── config.py             # Centralized configuration constants
├── models.py             # Dataclass definitions (Hotel, Reservation, RuleConfig, etc.)
├── db.py                 # PostgreSQL schema & CRUD operations
├── api_client.py         # Mews Connector API client with pagination
├── etl.py                # Raw API JSON → domain dataclass transforms
├── metrics.py            # Occupancy & pickup-rate computation
├── rules_engine.py       # JSON-based dynamic pricing rules
├── scheduler.py          # APScheduler batch orchestration
├── utils.py              # Shared utilities (date parsing, field detection)
├── main.py               # Production entry point
├── requirements.txt      # Python dependencies
├── pytest.ini            # Test configuration
│
├── tools/
│   └── local_gui.py      # Browser-based SPA dashboard (zero dependencies)
│
├── rms_engine/
│   ├── __init__.py
│   └── config_loader.py  # File-based hotel configuration loader
│
└── tests/
    ├── conftest.py
    ├── test_api_client.py
    ├── test_config_loader.py
    ├── test_db_scheduler.py
    ├── test_etl.py
    ├── test_local_gui.py
    ├── test_metrics.py
    ├── test_rules_engine.py
    └── test_utils.py
```

---

## Module Reference

### `config.py` — Configuration

All tuneable constants live here. Key settings:

| Constant | Default | Description |
|----------|---------|-------------|
| `DB_DSN` | `dbname=maya ...` | PostgreSQL connection string |
| `MEWS_BASE_URL` | `https://api.mews.com/api/connector/v1` | Mews API base URL |
| `BATCH_INTERVAL_MINUTES` | `5` | How often the scheduler runs |
| `DEFAULT_TOTAL_ROOMS_PER_TYPE` | `100` | Fallback room count per type |

---

### `models.py` — Data Models

All models are Python dataclasses with full type hints:

| Model | Purpose |
|-------|---------|
| `Hotel` | Tenant configuration (API tokens, enterprise ID) |
| `RoomType` | Room category metadata |
| `Reservation` | Parsed reservation with computed fields |
| `MetricsRow` | Per-room-type per-date occupancy & pickup |
| `RuleConfig` | JSON-based pricing rule definition |
| `FieldMap` | Auto-detected API field names |

---

### `rules_engine.py` — Dynamic Pricing

Rules use a simple, powerful JSON format:

```json
{
  "rule_name": "High Occupancy Surge",
  "conditions": {
    "occupancy_percentage": ">80"
  },
  "action": {
    "adjust_rate_percent": 10
  },
  "room_types": [],
  "enabled": true
}
```

**Conditions** support `>`, `<`, and `=` operators against numeric fields:
- `occupancy_percentage` — current occupancy as a percentage
- `booking_window` — days between booking and stay date
- `pickup_rate` — net new reservations since last batch

**Actions** support two adjustment types:
- `adjust_rate_percent` — percentage change (e.g., `10` = +10%)
- `adjust_rate_dollars` — flat dollar change (e.g., `50` = +$50)

**Room Types** filter which room categories the rule applies to. An empty list means "apply to all."

Rules are evaluated sequentially and **stack** — multiple rules can fire on the same reservation, each modifying the rate from the previous result.

---

### `api_client.py` — Mews Integration

The `MewsApiClient` handles:

- **Cursor-based pagination** — automatically fetches all pages for large hotels
- **Rate push-back** — `push_rate_update()` sends adjusted rates back to Mews via `rates/addRate`
- **Configurable endpoints** — base URL is per-hotel for staging/production flexibility

---

### `db.py` — Database Layer

PostgreSQL schema with full multi-tenant isolation:

| Table | Purpose |
|-------|---------|
| `hotels` | Tenant registry |
| `room_types` | Room categories per hotel |
| `reservations` | Parsed reservation data |
| `metrics` | Cached occupancy & pickup rates |
| `rules` | Pricing rule definitions (JSONB) |
| `audit_log` | Rate change history |

All queries are scoped by `hotel_id`. The schema is auto-created on first run via `create_schema()`.

---

### `tools/local_gui.py` — Interactive Dashboard

A fully self-contained browser-based SPA built with **zero external dependencies** — just Python's `http.server` + vanilla HTML/CSS/JS.

**Features:**
- **Login Screen** — hotel group authentication gate
- **Property Selector** — switch between properties in the sidebar
- **Occupancy Calendar** — monthly heat-map with color-coded occupancy (green = high, red = low)
- **Day Detail View** — per-room-type breakdown with rates and revenue
- **Rules Manager** — full CRUD with multi-condition builder
- **Rate Simulator** — preview how enabled rules affect sample reservations

---

## Dashboard Preview

### Calendar View
The occupancy calendar uses an intuitive color scheme:
- **Green** — High occupancy (>80%) — revenue is strong
- **Amber** — Medium occupancy (60-80%) — monitor closely
- **Red** — Low occupancy (<60%) — action needed

Click any day to see a detailed breakdown by room type, including occupancy, nightly rate, and projected revenue.

### Rate Simulator
Test your pricing rules against sample reservations before enabling them. The simulator shows the original rate, new rate, percentage change, and which rules were applied.

---

## Running Tests

```bash
# Run all tests
python -m pytest tests/ -v

# Run a specific test file
python -m pytest tests/test_rules_engine.py -v

# Run with coverage (requires pytest-cov)
python -m pytest tests/ --cov=. --cov-report=term-missing
```

**Current test count: 49 tests across 8 test files.**

---

## Configuration

### Hotel Setup (Database)

Hotels are stored in the `hotels` table. Each hotel requires:

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `client_token` | Mews Client Token |
| `access_token` | Mews Access Token |
| `enterprise_id` | Mews Enterprise ID |
| `base_url` | API base URL (default: Mews production) |
| `total_rooms_per_type` | Room count used for occupancy % calculation |

### Hotel Setup (File-Based)

Alternatively, place JSON config files in a `configs/` directory:

```json
{
  "hotel_id": 1,
  "name": "My Hotel",
  "client_token": "...",
  "access_token": "...",
  "enterprise_id": "..."
}
```

The `config_loader` module scans this directory and refreshes the cache every batch cycle.

---

## Environment Variables

While MAYA currently uses `config.py` for settings, you can override values using environment variables in a future setup:

| Variable | Maps To |
|----------|---------|
| `MAYA_DB_DSN` | `DB_DSN` |
| `MAYA_MEWS_BASE_URL` | `MEWS_BASE_URL` |
| `MAYA_BATCH_INTERVAL` | `BATCH_INTERVAL_MINUTES` |

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Python 3.9+ |
| Database | PostgreSQL (psycopg2) |
| Scheduler | APScheduler |
| PMS Integration | Mews Connector API v1 |
| HTTP Client | Requests |
| Dashboard | Vanilla HTML/CSS/JS (zero frameworks) |
| Testing | pytest |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  <sub>Built with precision for the hospitality industry.</sub>
</p>
