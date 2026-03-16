"""
MAYA (Machine Assisted Yield Automation) — Interactive local dashboard.

Launches a lightweight web server and opens a full-featured SaaS dashboard
in the default browser.  No external GUI framework required — uses only the
Python standard library (http.server, json, webbrowser).

Sections:  Login · Calendar (occupancy heat-map) · Rules (CRUD) · Rate Simulator · Change Log
"""

from __future__ import annotations

import html as html_mod
import http.server
import json
import os
import socket
import tempfile
import threading
import webbrowser
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse


# ═══════════════════════════════════════════════════════════════════════════════
# PURE LOGIC  (no I/O — safe to import and test in isolation)
# ═══════════════════════════════════════════════════════════════════════════════

def simulate_rate_changes(
    rules: List[Dict[str, Any]],
    sample_reservations: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Apply JSON-format rules to sample reservations and return results.

    Each result dict has keys: room_type, original_rate, new_rate, applied_rules.
    """
    simulated: List[Dict[str, Any]] = []
    for res in sample_reservations:
        new_rate = res["current_rate"]
        applied: List[str] = []
        for rule in rules:
            if _rule_matches(rule, res):
                action = rule.get("action", {})
                if "adjust_rate_percent" in action:
                    new_rate *= 1 + action["adjust_rate_percent"] / 100
                if "adjust_rate_dollars" in action:
                    new_rate += action["adjust_rate_dollars"]
                applied.append(rule.get("rule_name", ""))
        simulated.append({
            "room_type": res["room_type"],
            "original_rate": res["current_rate"],
            "new_rate": round(new_rate, 2),
            "applied_rules": ", ".join(applied),
        })
    return simulated


def _rule_matches(rule: Dict[str, Any], res: Dict[str, Any]) -> bool:
    """Return True when every condition in *rule* is satisfied by *res*."""
    rt_filter = rule.get("room_types", [])
    if rt_filter and res.get("room_type") not in rt_filter:
        return False
    for key, val in rule.get("conditions", {}).items():
        if key not in res:
            return False
        res_val = res[key]
        if isinstance(val, str):
            if val.startswith(">") and not res_val > float(val[1:]):
                return False
            elif val.startswith("<") and not res_val < float(val[1:]):
                return False
            elif val.startswith("=") and not res_val == float(val[1:]):
                return False
        else:
            if res_val != val:
                return False
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# STATIC HTML PREVIEW  (backward-compatible — used by existing tests)
# ═══════════════════════════════════════════════════════════════════════════════

_DEFAULT_SAMPLES: List[Dict[str, Any]] = [
    {"room_type": "Standard", "occupancy_percentage": 85, "booking_window": 30, "current_rate": 175},
    {"room_type": "Deluxe",   "occupancy_percentage": 50, "booking_window": 10, "current_rate": 245},
    {"room_type": "Suite",    "occupancy_percentage": 95, "booking_window": 5,  "current_rate": 395},
]


def preview_rate_changes_window(
    config_data: Dict[str, Any],
    sample_reservations: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """Open a static HTML preview in the browser (lightweight, non-interactive)."""
    if not config_data or "rules" not in config_data:
        print("Error: No rules loaded in config_data.")
        return
    samples = sample_reservations or _DEFAULT_SAMPLES
    preview = simulate_rate_changes(config_data["rules"], samples)
    try:
        fd, path = tempfile.mkstemp(suffix=".html", prefix="maya_preview_")
        with os.fdopen(fd, "w") as f:
            f.write(_build_static_html(preview))
        webbrowser.open(f"file://{path}")
    except Exception:
        _print_table(preview)


def _build_static_html(preview: List[Dict[str, Any]]) -> str:
    rows = ""
    for r in preview:
        rows += (
            f"<tr><td>{html_mod.escape(str(r['room_type']))}</td>"
            f"<td>${r['original_rate']:.2f}</td>"
            f"<td>${r['new_rate']:.2f}</td>"
            f"<td>{html_mod.escape(r['applied_rules'] or '-')}</td></tr>\n"
        )
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<title>Rate Preview</title></head><body>"
        "<h1>Rate Change Preview</h1><table border='1' cellpadding='6'>"
        "<tr><th>Room</th><th>Original</th><th>New</th><th>Rules</th></tr>"
        f"{rows}</table></body></html>"
    )


def _print_table(preview: List[Dict[str, Any]]) -> None:
    print("Rate Change Preview")
    print("=" * 60)
    for r in preview:
        print(f"  {r['room_type']:<12} ${r['original_rate']:<10.2f} -> ${r['new_rate']:<10.2f}  {r['applied_rules']}")


# ═══════════════════════════════════════════════════════════════════════════════
# IN-MEMORY APP STATE  (demo data for the interactive dashboard)
# ═══════════════════════════════════════════════════════════════════════════════

_INITIAL_RULES: List[Dict[str, Any]] = [
    {
        "id": 1, "rule_name": "High Occupancy Surge",
        "conditions": {"occupancy_percentage": ">80"},
        "action": {"adjust_rate_percent": 10},
        "room_types": [], "enabled": True,
    },
    {
        "id": 2, "rule_name": "Last-Minute Premium",
        "conditions": {"booking_window": "<3", "occupancy_percentage": ">50"},
        "action": {"adjust_rate_percent": 15},
        "room_types": ["Standard", "Deluxe"], "enabled": True,
    },
    {
        "id": 3, "rule_name": "Suite Peak Surcharge",
        "conditions": {"occupancy_percentage": ">70", "pickup_rate": ">5"},
        "action": {"adjust_rate_dollars": 50},
        "room_types": ["Suite"], "enabled": True,
    },
    {
        "id": 4, "rule_name": "Early Bird Discount",
        "conditions": {"booking_window": ">45"},
        "action": {"adjust_rate_percent": -5},
        "room_types": [], "enabled": False,
    },
]

_ROOM_TYPES = [
    {"name": "Standard", "base_rate": 175, "total_rooms": 40},
    {"name": "Deluxe",   "base_rate": 245, "total_rooms": 30},
    {"name": "Suite",    "base_rate": 395, "total_rooms": 15},
]

# Demo hotel / group data for the login + property selector
_DEMO_HOTELS = [
    {"id": 1, "name": "The Grand Marina", "group": "Coastal Hospitality Group", "city": "San Diego", "rooms": 85},
    {"id": 2, "name": "Skyline Tower Hotel", "group": "Coastal Hospitality Group", "city": "Los Angeles", "rooms": 120},
    {"id": 3, "name": "Harbor View Resort", "group": "Coastal Hospitality Group", "city": "Santa Barbara", "rooms": 65},
]


class AppState:
    """Mutable in-memory state for the web-app session."""

    def __init__(self) -> None:
        self.rules: List[Dict[str, Any]] = [dict(r) for r in _INITIAL_RULES]
        self._next_id: int = 100
        self.authenticated: bool = False
        self.current_hotel_id: int = 1

    def add_rule(self, data: Dict[str, Any]) -> Dict[str, Any]:
        rule = {
            "id": self._next_id,
            "rule_name": data.get("rule_name", "Untitled"),
            "conditions": data.get("conditions", {}),
            "action": data.get("action", {}),
            "room_types": data.get("room_types", []),
            "enabled": True,
        }
        self._next_id += 1
        self.rules.append(rule)
        return rule

    def toggle_rule(self, rule_id: int) -> bool:
        for r in self.rules:
            if r["id"] == rule_id:
                r["enabled"] = not r["enabled"]
                return True
        return False

    def delete_rule(self, rule_id: int) -> bool:
        before = len(self.rules)
        self.rules = [r for r in self.rules if r["id"] != rule_id]
        return len(self.rules) < before

    def enabled_rules(self) -> List[Dict[str, Any]]:
        return [r for r in self.rules if r.get("enabled")]


# ═══════════════════════════════════════════════════════════════════════════════
# DATA GENERATORS  (deterministic sample data based on date)
# ═══════════════════════════════════════════════════════════════════════════════

def _occ_for_day(year: int, month: int, day: int) -> int:
    """Return a deterministic occupancy percentage for the given date."""
    d = date(year, month, day)
    h = hash(d.isoformat()) & 0xFFFF
    base = 68 if d.weekday() < 5 else 82
    return max(18, min(98, base + (h % 30) - 12))


def _occ_for_room(year: int, month: int, day: int, rt_name: str) -> int:
    """Deterministic per-room-type occupancy pct (varies by room name hash)."""
    d = date(year, month, day)
    h = hash(d.isoformat() + rt_name) & 0xFFFF
    base = 65 if d.weekday() < 5 else 80
    return max(15, min(99, base + (h % 35) - 14))


def _rate_for_room(base_rate: float, occ_pct: int) -> float:
    """Simple demand-based pricing: higher occupancy -> higher rate."""
    if occ_pct > 85:
        return round(base_rate * 1.20, 2)
    if occ_pct > 70:
        return round(base_rate * 1.08, 2)
    if occ_pct < 40:
        return round(base_rate * 0.90, 2)
    return base_rate


def _gen_calendar(year: int, month: int) -> Dict[str, Any]:
    _, num_days = monthrange(year, month)
    days = {}
    for d in range(1, num_days + 1):
        total_rooms = sum(rt["total_rooms"] for rt in _ROOM_TYPES)

        # per-room-type breakdown
        rt_details = []
        day_booked = 0
        day_revenue = 0.0
        for rt in _ROOM_TYPES:
            occ_pct = _occ_for_room(year, month, d, rt["name"])
            booked = int(rt["total_rooms"] * occ_pct / 100)
            rate = _rate_for_room(rt["base_rate"], occ_pct)
            rev = round(booked * rate, 2)
            day_booked += booked
            day_revenue += rev
            rt_details.append({
                "name": rt["name"],
                "total_rooms": rt["total_rooms"],
                "occupancy_pct": occ_pct,
                "booked": booked,
                "rate": rate,
                "revenue": rev,
            })

        overall_occ = round(day_booked / total_rooms * 100) if total_rooms else 0
        days[str(d)] = {
            "occupancy_pct": overall_occ,
            "booked": day_booked,
            "total": total_rooms,
            "revenue": round(day_revenue, 2),
            "weekday": date(year, month, d).strftime("%a"),
            "room_types": rt_details,
        }
    return {
        "year": year, "month": month,
        "month_name": date(year, month, 1).strftime("%B %Y"),
        "days_in_month": num_days,
        "first_weekday": date(year, month, 1).weekday(),
        "days": days,
    }


def _occ_thresholds(ref_year: int, ref_month: int, months_back: int = 12) -> Dict[str, int]:
    """Compute occupancy colour thresholds from the trailing *months_back* months.

    Returns ``{"low": p33, "high": p66}`` so the caller can colour-code
    occupancy relative to *this property's* historic range rather than using
    fixed 60 / 80 cut-offs.

    Algorithm: gather every day's overall-occupancy value for the previous
    *months_back* months (not including the current view month), sort them,
    then return the 33rd and 66th percentiles as the low/high boundaries.
    """
    all_occ: List[int] = []
    y, m = ref_year, ref_month
    for _ in range(months_back):
        m -= 1
        if m < 1:
            m = 12
            y -= 1
        cal = _gen_calendar(y, m)
        for day_data in cal["days"].values():
            all_occ.append(day_data["occupancy_pct"])

    if not all_occ:
        return {"low": 60, "high": 80}   # safe fallback

    all_occ.sort()
    n = len(all_occ)
    p33 = all_occ[int(n * 0.33)]
    p66 = all_occ[int(n * 0.66)]
    return {"low": int(p33), "high": int(p66)}


# ── condition → plain-English mappings ────────────────────────────────────────
_COND_LABELS: Dict[str, str] = {
    "occupancy_percentage": "occupancy",
    "booking_window":       "booking window",
    "pickup_rate":          "pickup rate",
    "pickup_rate_cycle":    "pickup rate (since last cycle)",
    "pickup_rate_1d":       "pickup rate (1 day)",
    "pickup_rate_7d":       "pickup rate (7 days)",
    "pickup_rate_14d":      "pickup rate (14 days)",
    "pickup_rate_30d":      "pickup rate (30 days)",
}
_COND_UNITS: Dict[str, str] = {
    "occupancy_percentage": "%",
    "booking_window":       "d",
    "pickup_rate":          "",
    "pickup_rate_cycle":    "",
    "pickup_rate_1d":       "",
    "pickup_rate_7d":       "",
    "pickup_rate_14d":      "",
    "pickup_rate_30d":      "",
}
_COND_OPS: Dict[str, str] = {
    ">": "exceeded",
    "<": "fell below",
    "=": "hit exactly",
}


def _describe_from_conditions(
    rule: Dict[str, Any],
    rt: str,
    actual_vals: Dict[str, Any],
    pct_change: float,
) -> str:
    """Build a human-readable description from a rule's conditions and action.

    Reads the rule's ``conditions`` and ``action`` dicts directly — no rule-name
    pattern matching, so it works correctly for any rule regardless of its name.
    """
    conditions = rule.get("conditions", {})
    rule_name  = rule.get("rule_name", "Rule")

    # One plain-English clause per condition, e.g.
    #   "occupancy (87%) exceeded 80%"
    #   "booking window (2d) fell below 3d"
    clauses: List[str] = []
    for field, expr in conditions.items():
        op        = expr[0]                              # >, <, or =
        threshold = expr[1:]                             # numeric string
        label     = _COND_LABELS.get(field, field.replace("_", " "))
        unit      = _COND_UNITS.get(field, "")
        op_phrase = _COND_OPS.get(op, op)
        actual    = actual_vals.get(field)
        if actual is not None:
            clauses.append(f"{label} ({actual}{unit}) {op_phrase} {threshold}{unit}")
        else:
            clauses.append(f"{label} {op_phrase} {threshold}{unit}")

    cond_text = " and ".join(clauses) if clauses else "conditions met"

    # Action clause uses the actual pct_change so it reflects what was applied
    verb = "raised" if pct_change > 0 else "reduced"
    adj_text = f"{verb} {rt} rate {abs(pct_change)}%"

    return f"{cond_text} \u2014 {rule_name} {adj_text}"


def _gen_changelog() -> List[Dict[str, Any]]:
    """Generate deterministic demo change-log entries (batch cycles).

    Each cycle represents a scheduler run.  Some cycles detect occupancy
    shifts and fire rules (producing rate changes), others find no
    actionable conditions and are logged as no-change cycles.

    Returns a list of *cycle* objects (not flat rows).  Each cycle dict:
      - cycle, timestamp, has_changes
      - changes: list of individual rate adjustments with descriptions
    """
    import random as _rng
    _rng.seed(42)  # deterministic

    # Look up rules by name so we can read their actual conditions/actions
    rule_lookup: Dict[str, Dict[str, Any]] = {r["rule_name"]: r for r in _INITIAL_RULES}

    cycles: List[Dict[str, Any]] = []
    base_ts    = datetime(2026, 3, 1, 6, 0, 0)
    rule_names = list(rule_lookup.keys())
    room_names = ["Standard", "Deluxe", "Suite"]
    base_rates = {"Standard": 175.0, "Deluxe": 245.0, "Suite": 395.0}

    def _actual_vals_for(rule_obj: Dict[str, Any], occ: int) -> Dict[str, Any]:
        """Generate a plausible actual value for every condition field in the rule,
        guaranteed to satisfy the condition (so the description is consistent).
        """
        vals: Dict[str, Any] = {}
        for field, expr in rule_obj.get("conditions", {}).items():
            op = expr[0]
            t  = float(expr[1:])
            if field == "occupancy_percentage":
                vals[field] = occ          # already generated, reuse it
            elif field == "booking_window":
                if op == ">":
                    vals[field] = _rng.randint(int(t) + 1, int(t) + 30)
                elif op == "<":
                    vals[field] = _rng.randint(1, max(1, int(t) - 1))
                else:
                    vals[field] = int(t)
            elif field == "pickup_rate":
                if op == ">":
                    vals[field] = _rng.randint(int(t) + 1, int(t) + 10)
                elif op == "<":
                    vals[field] = _rng.randint(0, max(0, int(t) - 1))
                else:
                    vals[field] = int(t)
            # unknown fields: omit — description will render without actual value
        return vals

    for cycle_num in range(1, 51):
        ts         = base_ts + timedelta(minutes=5 * (cycle_num - 1))
        has_change = _rng.random() < 0.45  # ~45% of cycles have changes

        changes: List[Dict[str, Any]] = []
        if has_change:
            n_changes = _rng.randint(1, 3)
            for _ in range(n_changes):
                rt       = _rng.choice(room_names)
                name     = _rng.choice(rule_names)
                rule_obj = rule_lookup[name]
                base     = base_rates[rt]
                occ      = _rng.randint(55, 98)

                # Derive rate direction from the rule's action, not its name
                action     = rule_obj.get("action", {})
                pct_adj    = action.get("adjust_rate_percent")
                dollar_adj = action.get("adjust_rate_dollars")
                is_negative = (
                    (pct_adj    is not None and pct_adj    < 0) or
                    (dollar_adj is not None and dollar_adj < 0)
                )
                pct_change = round(
                    _rng.uniform(-8, -2) if is_negative else _rng.uniform(3, 18), 1
                )
                new_rate   = round(base * (1 + pct_change / 100), 2)
                actual     = _actual_vals_for(rule_obj, occ)

                changes.append({
                    "room_type":     rt,
                    "rule_name":     name,
                    "original_rate": base,
                    "new_rate":      new_rate,
                    "change_pct":    pct_change,
                    "occupancy_pct": occ,
                    "description":   _describe_from_conditions(rule_obj, rt, actual, pct_change),
                })

        cycles.append({
            "cycle":       cycle_num,
            "timestamp":   ts.strftime("%Y-%m-%d %H:%M:%S"),
            "has_changes": bool(changes),
            "changes":     changes,
        })

    cycles.reverse()  # newest first
    return cycles


# ═══════════════════════════════════════════════════════════════════════════════
# HTTP REQUEST HANDLER
# ═══════════════════════════════════════════════════════════════════════════════

class _Handler(http.server.BaseHTTPRequestHandler):
    state: AppState

    def log_message(self, fmt, *args):  # noqa: suppress console noise
        pass

    # ── routing ───────────────────────────────────────────────────────────
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self._html(_APP_HTML)
        elif path == "/api/rules":
            self._json(self.state.rules)
        elif path.startswith("/api/calendar/"):
            parts = path.strip("/").split("/")
            try:
                yr, mo = int(parts[2]), int(parts[3])
                cal = _gen_calendar(yr, mo)
                cal["thresholds"] = _occ_thresholds(yr, mo)
                self._json(cal)
            except (IndexError, ValueError):
                self._json({"error": "use /api/calendar/YYYY/MM"}, 400)
        elif path == "/api/room_types":
            self._json(_ROOM_TYPES)
        elif path == "/api/hotels":
            self._json(_DEMO_HOTELS)
        elif path == "/api/changelog":
            self._json(_gen_changelog())
        elif path == "/api/session":
            hotel = next((h for h in _DEMO_HOTELS if h["id"] == self.state.current_hotel_id), _DEMO_HOTELS[0])
            self._json({"authenticated": self.state.authenticated, "hotel": hotel})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        body = self._read_body()
        if path == "/api/login":
            # Demo login: accept any non-empty credentials
            email = body.get("email", "").strip()
            password = body.get("password", "").strip()
            if email and password:
                self.state.authenticated = True
                hotel = next((h for h in _DEMO_HOTELS if h["id"] == self.state.current_hotel_id), _DEMO_HOTELS[0])
                self._json({"ok": True, "hotel": hotel})
            else:
                self._json({"error": "Email and password are required."}, 401)
        elif path == "/api/switch-hotel":
            hotel_id = body.get("hotel_id")
            if hotel_id and any(h["id"] == hotel_id for h in _DEMO_HOTELS):
                self.state.current_hotel_id = hotel_id
                hotel = next(h for h in _DEMO_HOTELS if h["id"] == hotel_id)
                self._json({"ok": True, "hotel": hotel})
            else:
                self._json({"error": "Invalid hotel"}, 400)
        elif path == "/api/logout":
            self.state.authenticated = False
            self._json({"ok": True})
        elif path == "/api/rules":
            rule = self.state.add_rule(body)
            self._json(rule, 201)
        elif path.startswith("/api/rules/") and path.endswith("/toggle"):
            rid = int(path.split("/")[3])
            self.state.toggle_rule(rid)
            self._json({"ok": True})
        elif path == "/api/simulate":
            enabled = self.state.enabled_rules()
            samples = body.get("reservations", _DEFAULT_SAMPLES)
            self._json(simulate_rate_changes(enabled, samples))
        elif path == "/api/shutdown":
            self._json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self._json({"error": "not found"}, 404)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/api/rules/"):
            rid = int(path.split("/")[3])
            self.state.delete_rule(rid)
            self._json({"ok": True})
        else:
            self._json({"error": "not found"}, 404)

    # ── helpers ───────────────────────────────────────────────────────────
    def _read_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def _json(self, data: Any, code: int = 200) -> None:
        out = json.dumps(data, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def _html(self, content: str) -> None:
        out = content.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


# ═══════════════════════════════════════════════════════════════════════════════
# HTML / CSS / JS — single-page dashboard application
# ═══════════════════════════════════════════════════════════════════════════════

_APP_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAYA — Revenue Management</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#f1f5f9;--sidebar:#0f172a;--sidebar-hover:#1e293b;
  --card:#fff;--border:#e2e8f0;--text:#1e293b;--muted:#64748b;
  --pri:#3b82f6;--pri-hover:#2563eb;--green:#22c55e;--amber:#f59e0b;--red:#ef4444;
  --radius:10px;--shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.06);
}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  font-size:14px;line-height:1.5;color:var(--text);background:var(--bg);display:flex}

/* ── login screen ── */
.login-screen{position:fixed;inset:0;background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0f172a 100%);
  display:flex;align-items:center;justify-content:center;z-index:1000;flex-direction:column}
.login-screen.hidden{display:none}
.login-card{background:#fff;border-radius:16px;padding:40px;width:420px;max-width:90vw;
  box-shadow:0 25px 60px rgba(0,0,0,.3)}
.login-brand{text-align:center;margin-bottom:32px}
.login-brand h1{font-size:36px;font-weight:800;color:#0f172a;letter-spacing:-1px;margin-bottom:4px}
.login-brand h1 span{color:var(--pri)}
.login-brand p{color:var(--muted);font-size:13px;letter-spacing:.3px;text-transform:uppercase;font-weight:500}
.login-form .form-group{margin-bottom:20px}
.login-form .form-group label{display:block;font-size:12px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.login-form .form-group input{width:100%;padding:12px 14px;border:1.5px solid var(--border);
  border-radius:8px;font-size:14px;outline:none;transition:border .15s,box-shadow .15s;background:#f8fafc}
.login-form .form-group input:focus{border-color:var(--pri);box-shadow:0 0 0 3px rgba(59,130,246,.1);background:#fff}
.login-btn{width:100%;padding:13px;background:var(--pri);color:#fff;border:none;border-radius:8px;
  font-size:15px;font-weight:600;cursor:pointer;transition:background .15s}
.login-btn:hover{background:var(--pri-hover)}
.login-error{color:var(--red);font-size:13px;margin-bottom:14px;display:none;text-align:center}
.login-hint{text-align:center;margin-top:20px;color:var(--muted);font-size:12px}

/* ── sidebar ── */
.sidebar{width:230px;min-height:100vh;background:var(--sidebar);color:#cbd5e1;
  display:flex;flex-direction:column;padding:24px 0;position:fixed;top:0;left:0;bottom:0;z-index:10}
.brand{font-size:20px;font-weight:700;color:#fff;padding:0 24px 20px;letter-spacing:-.3px}
.brand span{color:var(--pri)}

/* property selector */
.prop-selector{margin:0 16px 20px;position:relative}
.prop-btn{width:100%;padding:10px 12px;background:var(--sidebar-hover);border:1px solid rgba(255,255,255,.1);
  border-radius:8px;color:#e2e8f0;font-size:13px;font-weight:500;cursor:pointer;
  display:flex;align-items:center;gap:10px;transition:all .15s;text-align:left}
.prop-btn:hover{border-color:rgba(59,130,246,.4);background:rgba(59,130,246,.1)}
.prop-icon{width:32px;height:32px;border-radius:6px;background:linear-gradient(135deg,var(--pri),#6366f1);
  display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:13px;flex-shrink:0}
.prop-info{flex:1;min-width:0}
.prop-name{display:block;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prop-city{display:block;font-size:11px;color:#94a3b8}
.prop-arrow{font-size:10px;color:#64748b;transition:transform .15s}
.prop-dropdown{position:absolute;top:calc(100% + 6px);left:0;right:0;background:#1e293b;border:1px solid rgba(255,255,255,.1);
  border-radius:8px;padding:6px;z-index:20;box-shadow:0 10px 30px rgba(0,0,0,.4);display:none}
.prop-dropdown.open{display:block}
.prop-option{padding:10px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:10px;
  color:#cbd5e1;font-size:13px;transition:all .1s}
.prop-option:hover{background:rgba(59,130,246,.15);color:#fff}
.prop-option.active{background:rgba(59,130,246,.2);color:#fff}
.prop-option .prop-icon{width:28px;height:28px;font-size:11px}

.nav-item{display:flex;align-items:center;gap:12px;padding:11px 24px;color:#94a3b8;
  text-decoration:none;font-size:14px;font-weight:500;border-left:3px solid transparent;
  transition:all .15s}
.nav-item:hover{background:var(--sidebar-hover);color:#e2e8f0}
.nav-item.active{color:#fff;border-left-color:var(--pri);background:rgba(59,130,246,.1)}
.nav-item svg{width:18px;height:18px;flex-shrink:0;opacity:.7}
.nav-item.active svg{opacity:1}

.sidebar-footer{margin-top:auto;padding:16px 24px;border-top:1px solid rgba(255,255,255,.06)}
.logout-btn{display:flex;align-items:center;gap:10px;color:#94a3b8;font-size:13px;font-weight:500;
  cursor:pointer;padding:8px 0;transition:color .15s;background:none;border:none;width:100%;text-align:left}
.logout-btn:hover{color:#ef4444}

/* ── main ── */
.main{margin-left:230px;flex:1;padding:32px 40px;min-height:100vh}
.page{display:none}.page.active{display:block}
.page-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.page-hdr h1{font-size:22px;font-weight:700}

/* ── cards ── */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:28px}
.card{background:var(--card);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
.card-label{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
.card-value{font-size:26px;font-weight:700}
.card-sub{font-size:12px;color:var(--muted);margin-top:2px}

/* ── table ── */
.tbl{width:100%;border-collapse:collapse;background:var(--card);border-radius:var(--radius);
  overflow:hidden;box-shadow:var(--shadow)}
.tbl th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);padding:12px 16px;border-bottom:2px solid var(--border);font-weight:600}
.tbl td{padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:#f8fafc}

/* ── buttons ── */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:7px;
  font-size:13px;font-weight:600;border:none;cursor:pointer;transition:all .15s}
.btn-pri{background:var(--pri);color:#fff}.btn-pri:hover{background:var(--pri-hover)}
.btn-sm{padding:5px 10px;font-size:12px;border-radius:5px}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-outline:hover{background:#f8fafc}
.btn-danger{background:transparent;border:1px solid var(--border);color:var(--red)}
.btn-danger:hover{background:#fef2f2}

/* ── toggle switch ── */
.toggle{position:relative;width:40px;height:22px;cursor:pointer}
.toggle input{display:none}
.toggle .slider{position:absolute;inset:0;background:#cbd5e1;border-radius:22px;transition:.2s}
.toggle .slider::before{content:"";position:absolute;width:16px;height:16px;left:3px;bottom:3px;
  background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked+.slider{background:var(--green)}
.toggle input:checked+.slider::before{transform:translateX(18px)}

/* ── badge ── */
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.badge-green{background:#dcfce7;color:#166534}
.badge-amber{background:#fef3c7;color:#92400e}
.badge-red{background:#fee2e2;color:#991b1b}

/* ── calendar ── */
.cal-nav{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.cal-nav h2{font-size:18px;min-width:180px;text-align:center}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.cal-hdr{text-align:center;font-size:11px;font-weight:600;color:var(--muted);padding:6px 0;
  text-transform:uppercase}
.cal-cell{background:var(--card);border-radius:8px;padding:8px;min-height:72px;
  box-shadow:var(--shadow);cursor:pointer;transition:transform .1s,box-shadow .15s;position:relative}
.cal-cell:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.1)}
.cal-cell.empty{background:transparent;box-shadow:none;cursor:default}
.cal-day{font-size:12px;font-weight:600;margin-bottom:4px}
.cal-occ{font-size:18px;font-weight:700;margin-bottom:2px}
.cal-bar{height:4px;border-radius:2px;margin-top:4px}
.cal-booked{font-size:10px;color:var(--muted)}
.cal-rev{font-size:11px;font-weight:600;color:var(--text);margin-top:2px}
.cal-detail{background:var(--card);border-radius:var(--radius);padding:20px;
  box-shadow:var(--shadow);margin-top:16px}

/* ── modal ── */
.modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:100;
  display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.modal-overlay.hidden{display:none}
.modal{background:#fff;border-radius:14px;padding:28px;width:440px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.2)}
.modal h2{font-size:18px;margin-bottom:20px}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:12px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}
.form-group input,.form-group select{width:100%;padding:9px 12px;border:1px solid var(--border);
  border-radius:7px;font-size:14px;outline:none;transition:border .15s}
.form-group input:focus,.form-group select:focus{border-color:var(--pri)}
.form-row{display:grid;grid-template-columns:1fr 80px 1fr;gap:10px}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:24px}

/* ── sim ── */
.sim-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.sim-panel{background:var(--card);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
.sim-panel h3{font-size:15px;font-weight:600;margin-bottom:14px}
.change-pos{color:var(--red);font-weight:600}
.change-neg{color:var(--green);font-weight:600}
.change-zero{color:var(--muted)}

/* ── rule form extras ── */
.cond-rows{display:flex;flex-direction:column;gap:8px}
.cond-row{display:grid;grid-template-columns:1fr 60px 90px 32px;gap:8px;align-items:center}
.cond-field-group{display:flex;gap:6px;min-width:0}
.cond-field-group select{flex:1;min-width:0}
.cond-field-group .pw{flex:0 0 130px;display:none}
.cond-field-group .pw.visible{display:block}
.cond-row select,.cond-row input{padding:8px 10px;border:1px solid var(--border);border-radius:6px;
  font-size:13px;outline:none}
.cond-row select:focus,.cond-row input:focus{border-color:var(--pri)}
.btn-icon{width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;
  cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--muted)}
.btn-icon:hover{background:#fee2e2;color:var(--red);border-color:var(--red)}
.add-cond{font-size:12px;color:var(--pri);cursor:pointer;font-weight:600;border:none;
  background:none;padding:4px 0;text-align:left}
.add-cond:hover{text-decoration:underline}
.rt-group{position:relative;margin-top:4px}
.rt-select-btn{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;
  font-size:14px;cursor:pointer;background:#fff;text-align:left;display:flex;justify-content:space-between;align-items:center}
.rt-select-btn:hover{border-color:var(--pri)}
.rt-select-btn .arrow{font-size:10px;color:var(--muted)}
.rt-dropdown{position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid var(--border);
  border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:50;display:none;padding:6px 0;max-height:220px;overflow-y:auto}
.rt-dropdown.open{display:block}
.rt-dropdown .rt-toggle-all{padding:8px 14px;font-size:12px;font-weight:600;color:var(--pri);
  cursor:pointer;border-bottom:1px solid var(--border);display:block;background:none;border-left:none;border-right:none;border-top:none;width:100%;text-align:left}
.rt-dropdown .rt-toggle-all:hover{background:#f8fafc}
.rt-dropdown label{display:flex;align-items:center;gap:8px;padding:8px 14px;font-size:13px;cursor:pointer;transition:background .1s}
.rt-dropdown label:hover{background:#f8fafc}
.rt-dropdown input[type=checkbox]{accent-color:var(--pri)}
.adj-dual{display:flex;flex-direction:column;gap:10px}
.adj-option{display:grid;grid-template-columns:20px 120px 1fr;gap:8px;align-items:center;cursor:pointer}
.adj-option input[type=checkbox]{accent-color:var(--pri)}
.adj-label{font-size:13px;font-weight:500}
.adj-option input[type=number]{padding:9px 12px;border:1px solid var(--border);border-radius:7px;
  font-size:14px;outline:none;transition:border .15s,opacity .15s}
.adj-option input[type=number]:focus{border-color:var(--pri)}
.adj-option input[type=number]:disabled{opacity:.4;background:#f8fafc;cursor:not-allowed}
.tag{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:500;
  background:#f1f5f9;color:var(--text);margin:1px 2px}

/* ── change log ── */
.cl-toolbar{display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.cl-toggle{display:flex;background:var(--card);border-radius:8px;border:1px solid var(--border);overflow:hidden;box-shadow:var(--shadow)}
.cl-toggle button{padding:8px 18px;font-size:13px;font-weight:600;border:none;cursor:pointer;
  background:transparent;color:var(--muted);transition:all .15s}
.cl-toggle button.active{background:var(--pri);color:#fff}
.cl-toggle button:hover:not(.active){background:#f1f5f9}
.cl-stats{display:flex;gap:20px;margin-left:auto}
.cl-stat{font-size:13px;color:var(--muted)}.cl-stat strong{color:var(--text)}
.cl-cycle-num{font-weight:700;color:var(--pri);font-size:12px}
.cl-rate-arrow{font-weight:700;margin:0 4px}
.cl-pct-up{color:var(--red);font-weight:600;font-size:12px}
.cl-pct-down{color:var(--green);font-weight:600;font-size:12px}
/* collapsed cycle row */
.cl-group{cursor:pointer;transition:background .15s}
.cl-group:hover{background:#f8fafc !important}
.cl-group td{border-bottom:1px solid var(--border);padding:12px 14px}
.cl-chevron{display:inline-block;width:18px;color:var(--muted);font-size:11px;transition:transform .2s;margin-right:4px}
.cl-group.open .cl-chevron{transform:rotate(90deg)}
.cl-summary{font-size:13px;color:var(--text);line-height:1.5}
.cl-summary-count{font-weight:700;color:var(--pri)}
.cl-impact{font-size:13px;white-space:nowrap}
/* expanded detail rows */
.cl-detail{display:none;background:#f8fafc}
.cl-detail.visible{display:table-row}
.cl-detail td{padding:10px 14px 10px 44px;font-size:13px;border-bottom:1px solid #f1f5f9}
.cl-detail:last-child td{border-bottom:1px solid var(--border)}
.cl-desc{color:var(--text);line-height:1.5}
.cl-room-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:#e0f2fe;color:#0369a1;margin-right:6px}
/* no-change rows (only visible in "all" mode) */
.cl-nochange td{opacity:.5;padding:10px 14px;font-size:13px}
</style>
</head>
<body>

<!-- ═══ LOGIN SCREEN ═══ -->
<div class="login-screen" id="login-screen">
  <div class="login-card">
    <div class="login-brand">
      <h1>MA<span>YA</span></h1>
      <p>Machine Assisted Yield Automation</p>
    </div>
    <div class="login-error" id="login-error"></div>
    <form class="login-form" id="login-form" onsubmit="return handleLogin(event)">
      <div class="form-group">
        <label>Email Address</label>
        <input id="login-email" type="email" placeholder="you@company.com" value="demo@maya.io" required>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input id="login-password" type="password" placeholder="Enter your password" value="demo1234" required>
      </div>
      <button type="submit" class="login-btn">Sign In</button>
    </form>
    <div class="login-hint">Demo credentials are pre-filled &mdash; just click Sign In</div>
  </div>
</div>

<!-- ═══ SIDEBAR ═══ -->
<nav class="sidebar">
  <div class="brand">MA<span>YA</span></div>

  <!-- Property Selector -->
  <div class="prop-selector" id="prop-selector">
    <button class="prop-btn" onclick="togglePropDropdown()" id="prop-btn">
      <div class="prop-icon" id="prop-icon">GM</div>
      <div class="prop-info">
        <span class="prop-name" id="prop-name">The Grand Marina</span>
        <span class="prop-city" id="prop-city">San Diego</span>
      </div>
      <span class="prop-arrow">&#9662;</span>
    </button>
    <div class="prop-dropdown" id="prop-dropdown"></div>
  </div>

  <a href="#" class="nav-item active" data-page="calendar">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    Calendar</a>
  <a href="#" class="nav-item" data-page="rules">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
    Rules</a>
  <a href="#" class="nav-item" data-page="simulator">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
    Rate Simulator</a>
  <a href="#" class="nav-item" data-page="changelog">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
    Change Log</a>

  <div class="sidebar-footer">
    <button class="logout-btn" onclick="handleLogout()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      Sign Out
    </button>
  </div>
</nav>

<div class="main">
  <!-- Calendar (default view) -->
  <div class="page active" id="pg-calendar">
    <div class="page-hdr"><h1>Occupancy Calendar</h1></div>
    <div class="cal-nav">
      <button class="btn btn-outline btn-sm" onclick="calNav(-1)">&larr; Prev</button>
      <h2 id="cal-title"></h2>
      <button class="btn btn-outline btn-sm" onclick="calNav(1)">Next &rarr;</button>
    </div>
    <div class="cal-grid" id="cal-grid"></div>
    <div id="cal-detail" style="display:none"></div>
  </div>

  <!-- Rules -->
  <div class="page" id="pg-rules">
    <div class="page-hdr"><h1>Pricing Rules</h1>
      <button class="btn btn-pri" onclick="openModal()">+ Add Rule</button></div>
    <table class="tbl" id="rules-table"><thead><tr>
      <th>Rule Name</th><th>Conditions</th><th>Room Types</th><th>Action</th><th>Status</th><th style="width:80px"></th>
    </tr></thead><tbody></tbody></table>
  </div>

  <!-- Simulator -->
  <div class="page" id="pg-simulator">
    <div class="page-hdr"><h1>Rate Simulator</h1></div>
    <p style="color:var(--muted);margin-bottom:20px">Preview how your <strong>enabled</strong> rules affect sample reservations.</p>
    <div class="sim-grid">
      <div class="sim-panel">
        <h3>Sample Reservations</h3>
        <table class="tbl" id="sim-input"><thead><tr>
          <th>Room</th><th>Occupancy %</th><th>Window (days)</th><th>Pickup</th><th>Current Rate</th>
        </tr></thead><tbody></tbody></table>
        <div style="margin-top:16px;text-align:right">
          <button class="btn btn-pri" onclick="runSim()">Run Simulation</button>
        </div>
      </div>
      <div class="sim-panel">
        <h3>Results</h3>
        <table class="tbl" id="sim-output"><thead><tr>
          <th>Room</th><th>Original</th><th>New Rate</th><th>Change</th><th>Rules Applied</th>
        </tr></thead><tbody><tr><td colspan="5" style="color:var(--muted);text-align:center;padding:32px">
          Click "Run Simulation" to see results</td></tr></tbody></table>
      </div>
    </div>
  </div>

  <!-- Change Log -->
  <div class="page" id="pg-changelog">
    <div class="page-hdr"><h1>Change Log</h1></div>
    <div class="cl-toolbar">
      <div class="cl-toggle" id="cl-toggle">
        <button data-filter="all" onclick="setClFilter('all')">All Cycles</button>
        <button class="active" data-filter="changes" onclick="setClFilter('changes')">Changes Only</button>
      </div>
      <div class="cl-stats" id="cl-stats"></div>
    </div>
    <table class="tbl" id="cl-table"><thead><tr>
      <th style="width:40px"></th><th>Cycle</th><th>Timestamp</th><th>Description</th><th style="width:140px">Impact</th>
    </tr></thead><tbody></tbody></table>
  </div>
</div>

<!-- Add-Rule Modal -->
<div class="modal-overlay hidden" id="modal">
  <div class="modal" style="width:520px">
    <h2>Add Pricing Rule</h2>
    <form id="rule-form" onsubmit="return saveRule(event)">
      <div class="form-group">
        <label>Rule Name</label>
        <input id="f-name" required placeholder="e.g. Weekend Surge">
      </div>
      <div class="form-group">
        <label>Conditions</label>
        <div class="cond-rows" id="cond-rows"></div>
        <button type="button" class="add-cond" onclick="addCondRow()">+ Add condition</button>
      </div>
      <div class="form-group">
        <label>Apply to Room Types</label>
        <div class="rt-group" id="rt-group">
          <button type="button" class="rt-select-btn" onclick="toggleRtDropdown()">
            <span id="rt-summary">All Room Types</span>
            <span class="arrow">&#9662;</span>
          </button>
          <div class="rt-dropdown" id="rt-dropdown"></div>
        </div>
      </div>
      <div class="form-group">
        <label>Rate Adjustment</label>
        <p style="font-size:11px;color:var(--muted);margin-bottom:8px">Enable at least one. Both can be applied together.</p>
        <div class="adj-dual">
          <label class="adj-option">
            <input type="checkbox" id="f-adj-pct-on" checked onchange="adjToggle()">
            <span class="adj-label">Percentage (%)</span>
            <input id="f-adj-pct" type="number" step="0.01" placeholder="e.g. 10 or -5">
          </label>
          <label class="adj-option">
            <input type="checkbox" id="f-adj-dol-on" onchange="adjToggle()">
            <span class="adj-label">Dollar ($)</span>
            <input id="f-adj-dol" type="number" step="0.01" placeholder="e.g. 25 or -10" disabled>
          </label>
        </div>
        <div id="adj-error" style="color:var(--red);font-size:12px;display:none;margin-top:6px">At least one adjustment type must be enabled.</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-pri">Save Rule</button>
      </div>
    </form>
  </div>
</div>

<script>
/* ── login ── */
async function handleLogin(e){
  e.preventDefault();
  const email=document.getElementById('login-email').value;
  const pass=document.getElementById('login-password').value;
  const errEl=document.getElementById('login-error');
  errEl.style.display='none';
  try{
    const r=await api('/api/login',{method:'POST',body:JSON.stringify({email:email,password:pass})});
    if(r.ok){
      document.getElementById('login-screen').classList.add('hidden');
      updatePropSelector(r.hotel);
      loadHotelDropdown();
      loadCalendar();
    } else {
      errEl.textContent=r.error||'Login failed';errEl.style.display='block';
    }
  }catch(err){errEl.textContent='Connection error';errEl.style.display='block';}
  return false;
}

async function handleLogout(){
  await api('/api/logout',{method:'POST'});
  document.getElementById('login-screen').classList.remove('hidden');
}

/* ── property selector ── */
let _hotels=[];
async function loadHotelDropdown(){
  _hotels=await api('/api/hotels');
  renderPropDropdown();
}
function renderPropDropdown(){
  const dd=document.getElementById('prop-dropdown');
  dd.innerHTML=_hotels.map(h=>{
    const initials=h.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    return `<div class="prop-option${h.id===_currentHotelId?' active':''}" onclick="switchHotel(${h.id})">
      <div class="prop-icon">${initials}</div>
      <div class="prop-info"><span class="prop-name">${esc(h.name)}</span><span class="prop-city">${esc(h.city)}</span></div>
    </div>`;
  }).join('');
}
let _currentHotelId=1;
function updatePropSelector(h){
  _currentHotelId=h.id;
  const initials=h.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('prop-icon').textContent=initials;
  document.getElementById('prop-name').textContent=h.name;
  document.getElementById('prop-city').textContent=h.city;
}
function togglePropDropdown(){
  const dd=document.getElementById('prop-dropdown');
  dd.classList.toggle('open');
}
async function switchHotel(id){
  const r=await api('/api/switch-hotel',{method:'POST',body:JSON.stringify({hotel_id:id})});
  if(r.ok){
    updatePropSelector(r.hotel);
    _currentHotelId=id;
    renderPropDropdown();
    togglePropDropdown();
    // reload current page data
    const activePage=document.querySelector('.nav-item.active');
    if(activePage) load(activePage.dataset.page);
  }
}
// close dropdown on outside click
document.addEventListener('click',e=>{
  if(!e.target.closest('.prop-selector')){
    document.getElementById('prop-dropdown').classList.remove('open');
  }
  if(!e.target.closest('#rt-group')){
    document.getElementById('rt-dropdown')?.classList.remove('open');
  }
});

/* ── navigation ── */
document.querySelectorAll('.nav-item').forEach(a=>{
  a.addEventListener('click',e=>{
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    a.classList.add('active');
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    document.getElementById('pg-'+a.dataset.page).classList.add('active');
    load(a.dataset.page);
  });
});

function load(pg){
  if(pg==='rules') loadRules();
  else if(pg==='calendar') loadCalendar();
  else if(pg==='simulator') loadSimInput();
  else if(pg==='changelog') loadChangelog();
}

/* ── API helper ── */
async function api(path,opts={}){
  const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});
  return r.json();
}

/* ── rules ── */
const condFields={occupancy_percentage:'Occupancy %',booking_window:'Booking Window',pickup_rate:'Pickup Rate'};
const pickupWindows={cycle:'Since Last Cycle','1d':'Since Yesterday','7d':'Last 7 Days','14d':'Last 14 Days','30d':'Last 30 Days'};

async function loadRules(){
  const rules=await api('/api/rules');
  const tb=document.querySelector('#rules-table tbody');
  if(!rules.length){tb.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">No rules configured. Click "+ Add Rule" to create one.</td></tr>';return;}
  tb.innerHTML=rules.map(r=>{
    const condLabel=k=>{if(condFields[k])return condFields[k];if(k.startsWith('pickup_rate_')){const w=k.replace('pickup_rate_','');return 'Pickup ('+(pickupWindows[w]||w)+')';}return k;};
    const conds=Object.entries(r.conditions||{}).map(([k,v])=>`<span class="tag">${condLabel(k)} ${esc(String(v))}</span>`).join(' ');
    const rts=(r.room_types&&r.room_types.length)?r.room_types.map(t=>`<span class="tag">${esc(t)}</span>`).join(' '):'<span style="color:var(--muted);font-size:12px">All</span>';
    let actParts=[];
    if(r.action.adjust_rate_percent!=null){const v=r.action.adjust_rate_percent;actParts.push((v>0?'+':'')+v+'%');}
    if(r.action.adjust_rate_dollars!=null){const v=r.action.adjust_rate_dollars;actParts.push((v>0?'+$':'$')+v);}
    const act=actParts.join(', ');
    return `<tr>
      <td><strong>${esc(r.rule_name)}</strong></td><td>${conds}</td><td>${rts}</td><td>${esc(act)}</td>
      <td><label class="toggle"><input type="checkbox" ${r.enabled?'checked':''} onchange="toggleRule(${r.id})"><span class="slider"></span></label></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteRule(${r.id})">Delete</button></td></tr>`;
  }).join('');
}
async function toggleRule(id){await api(`/api/rules/${id}/toggle`,{method:'POST'});loadRules();}
async function deleteRule(id){await api(`/api/rules/${id}`,{method:'DELETE'});loadRules();}

/* ── rule form helpers ── */
let _condId=0;
function addCondRow(field,op,val){
  _condId++;
  let baseField=field||'occupancy_percentage';
  let windowVal='';
  if(baseField.startsWith('pickup_rate_')){windowVal=baseField.replace('pickup_rate_','');baseField='pickup_rate';}
  const fieldOpts=Object.entries(condFields).map(([k,v])=>`<option value="${k}"${k===baseField?' selected':''}>${v}</option>`).join('');
  const windowOpts=Object.entries(pickupWindows).map(([k,v])=>`<option value="${k}"${k===windowVal?' selected':''}>${v}</option>`).join('');
  const showWindow=baseField==='pickup_rate'?' visible':'';
  const div=document.createElement('div');div.className='cond-row';div.id='cr-'+_condId;
  div.innerHTML=`<div class="cond-field-group"><select class="cf" onchange="onCondFieldChange(this)">${fieldOpts}</select><select class="pw${showWindow}">${windowOpts}</select></div>`
    +`<select class="co"><option value=">"${op==='>'?' selected':''}>&gt;</option><option value="<"${op==='<'?' selected':''}>&lt;</option><option value="="${op==='='?' selected':''}>=</option></select>`
    +`<input class="cv" type="number" required placeholder="80" value="${val||''}">`
    +`<button type="button" class="btn-icon" onclick="rmCond('cr-${_condId}')">&times;</button>`;
  document.getElementById('cond-rows').appendChild(div);
}
function onCondFieldChange(sel){
  const pw=sel.closest('.cond-field-group').querySelector('.pw');
  if(sel.value==='pickup_rate') pw.classList.add('visible');
  else pw.classList.remove('visible');
}
function rmCond(id){document.getElementById(id)?.remove();if(!document.querySelectorAll('.cond-row').length)addCondRow();}

function openModal(){
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('rule-form').reset();
  document.getElementById('cond-rows').innerHTML='';
  addCondRow();
  adjToggle();
  api('/api/room_types').then(types=>{
    const dd=document.getElementById('rt-dropdown');
    dd.innerHTML='<button type="button" class="rt-toggle-all" onclick="toggleAllRt()">Deselect All</button>'
      +types.map(t=>`<label><input type="checkbox" class="rt-check" value="${esc(t.name)}" checked onchange="updateRtSummary()"> ${esc(t.name)}</label>`).join('');
    updateRtSummary();
  });
}
function closeModal(){document.getElementById('modal').classList.add('hidden');document.getElementById('rt-dropdown')?.classList.remove('open');}
function toggleRtDropdown(){document.getElementById('rt-dropdown').classList.toggle('open');}
function toggleAllRt(){
  const checks=document.querySelectorAll('.rt-check');
  const allChecked=[...checks].every(c=>c.checked);
  checks.forEach(c=>c.checked=!allChecked);
  updateRtSummary();
}
function updateRtSummary(){
  const checks=document.querySelectorAll('.rt-check');
  const total=checks.length;const checked=[...checks].filter(c=>c.checked).length;
  const btn=document.querySelector('.rt-toggle-all');
  if(btn) btn.textContent=checked===total?'Deselect All':'Select All';
  const summary=document.getElementById('rt-summary');
  if(checked===0) summary.textContent='No Room Types';
  else if(checked===total) summary.textContent='All Room Types';
  else summary.textContent=checked+' of '+total+' selected';
}
function adjToggle(){
  const pctOn=document.getElementById('f-adj-pct-on').checked;
  const dolOn=document.getElementById('f-adj-dol-on').checked;
  document.getElementById('f-adj-pct').disabled=!pctOn;
  document.getElementById('f-adj-dol').disabled=!dolOn;
  if(!pctOn) document.getElementById('f-adj-pct').value='';
  if(!dolOn) document.getElementById('f-adj-dol').value='';
  document.getElementById('adj-error').style.display=(!pctOn&&!dolOn)?'block':'none';
}

async function saveRule(e){
  e.preventDefault();
  const cond={};
  document.querySelectorAll('.cond-row').forEach(row=>{
    let f=row.querySelector('.cf').value;
    const o=row.querySelector('.co').value,v=row.querySelector('.cv').value;
    if(f==='pickup_rate'){const pw=row.querySelector('.pw');if(pw) f='pickup_rate_'+pw.value;}
    if(v) cond[f]=o+v;
  });
  const action={};
  const pctOn=document.getElementById('f-adj-pct-on').checked;
  const dolOn=document.getElementById('f-adj-dol-on').checked;
  if(!pctOn&&!dolOn){document.getElementById('adj-error').style.display='block';return false;}
  if(pctOn){const pv=parseFloat(document.getElementById('f-adj-pct').value);if(isNaN(pv)){alert('Enter a percentage value.');return false;}action.adjust_rate_percent=pv;}
  if(dolOn){const dv=parseFloat(document.getElementById('f-adj-dol').value);if(isNaN(dv)){alert('Enter a dollar value.');return false;}action.adjust_rate_dollars=dv;}
  const allRtChecks=document.querySelectorAll('.rt-check');
  const checkedRt=document.querySelectorAll('.rt-check:checked');
  if(allRtChecks.length>0&&checkedRt.length===0){alert('Please select at least one room type.');return false;}
  const roomTypes=[];
  if(checkedRt.length<allRtChecks.length) checkedRt.forEach(cb=>roomTypes.push(cb.value));
  await api('/api/rules',{method:'POST',body:JSON.stringify({
    rule_name:document.getElementById('f-name').value,
    conditions:cond,action:action,room_types:roomTypes
  })});
  closeModal();loadRules();return false;
}

/* ── calendar ── */
let calYear,calMonth,_calData=null;
{const d=new Date();calYear=d.getFullYear();calMonth=d.getMonth()+1;}
async function loadCalendar(){
  const d=await api(`/api/calendar/${calYear}/${calMonth}`);
  _calData=d;
  document.getElementById('cal-title').textContent=d.month_name;
  const g=document.getElementById('cal-grid');
  let html=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div class="cal-hdr">${d}</div>`).join('');
  const offset=d.first_weekday;
  const tHigh=d.thresholds.high, tLow=d.thresholds.low;
  for(let i=0;i<offset;i++) html+='<div class="cal-cell empty"></div>';
  for(let day=1;day<=d.days_in_month;day++){
    const info=d.days[String(day)];
    const pct=info.occupancy_pct;
    const color=pct>=tHigh?'var(--green)':pct>=tLow?'var(--amber)':'var(--red)';
    const rev=info.revenue>=1000?'$'+(info.revenue/1000).toFixed(1)+'k':'$'+info.revenue.toFixed(0);
    html+=`<div class="cal-cell" onclick="showDay(${day})">
      <div class="cal-day">${day}</div>
      <div class="cal-occ" style="color:${color}">${pct}%</div>
      <div class="cal-rev">${rev}</div>
      <div class="cal-bar" style="background:${color};width:${pct}%"></div></div>`;
  }
  g.innerHTML=html;
  document.getElementById('cal-detail').style.display='none';
}
function calNav(dir){calMonth+=dir;if(calMonth>12){calMonth=1;calYear++;}if(calMonth<1){calMonth=12;calYear--;}loadCalendar();}
const _months=['January','February','March','April','May','June','July','August','September','October','November','December'];
function showDay(day){
  if(!_calData) return;
  const info=_calData.days[String(day)];
  const pct=info.occupancy_pct;
  const tHigh=_calData.thresholds.high, tLow=_calData.thresholds.low;
  const color=pct>=tHigh?'green':pct>=tLow?'amber':'red';
  const el=document.getElementById('cal-detail');
  el.style.display='block';
  const rtRows=info.room_types.map(rt=>{
    const c=rt.occupancy_pct>=tHigh?'var(--green)':rt.occupancy_pct>=tLow?'var(--amber)':'var(--red)';
    return `<tr>
      <td><strong>${esc(rt.name)}</strong></td>
      <td style="color:${c};font-weight:600">${rt.occupancy_pct}%</td>
      <td>${rt.booked} / ${rt.total_rooms}</td>
      <td>$${rt.rate.toFixed(2)}</td>
      <td style="font-weight:600">$${rt.revenue.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
    </tr>`;
  }).join('');
  el.innerHTML=`<div class="cal-detail">
    <div style="display:flex;gap:32px;align-items:center;margin-bottom:20px">
      <h3 style="font-size:16px">${info.weekday}, ${_months[calMonth-1]} ${day}</h3>
      <span class="badge badge-${color}">${pct}% occupied</span>
    </div>
    <div class="cards" style="margin-bottom:24px">
      <div class="card"><div class="card-label">Rooms Booked</div><div class="card-value">${info.booked}<span style="font-size:14px;color:var(--muted)"> / ${info.total}</span></div></div>
      <div class="card"><div class="card-label">Occupancy</div><div class="card-value" style="color:var(--${color})">${pct}%</div></div>
      <div class="card"><div class="card-label">Projected Revenue</div><div class="card-value">$${info.revenue.toLocaleString(undefined,{minimumFractionDigits:2})}</div></div>
    </div>
    <h3 style="font-size:15px;margin-bottom:12px">Room Type Breakdown</h3>
    <table class="tbl"><thead><tr>
      <th>Room Type</th><th>Occupancy</th><th>Booked</th><th>Rate</th><th>Revenue</th>
    </tr></thead><tbody>${rtRows}</tbody></table>
  </div>`;
}

/* ── simulator ── */
const simData=[
  {room_type:'Standard',occupancy_percentage:85,booking_window:30,pickup_rate:8,current_rate:175},
  {room_type:'Deluxe',occupancy_percentage:50,booking_window:10,pickup_rate:3,current_rate:245},
  {room_type:'Suite',occupancy_percentage:95,booking_window:5,pickup_rate:7,current_rate:395},
  {room_type:'Standard',occupancy_percentage:40,booking_window:60,pickup_rate:2,current_rate:175},
  {room_type:'Deluxe',occupancy_percentage:90,booking_window:1,pickup_rate:10,current_rate:245},
];
function loadSimInput(){
  document.querySelector('#sim-input tbody').innerHTML=simData.map(r=>
    `<tr><td>${r.room_type}</td><td>${r.occupancy_percentage}%</td><td>${r.booking_window}</td><td>${r.pickup_rate}</td><td>$${r.current_rate.toFixed(2)}</td></tr>`).join('');
}
async function runSim(){
  const res=await api('/api/simulate',{method:'POST',body:JSON.stringify({reservations:simData})});
  document.querySelector('#sim-output tbody').innerHTML=res.map(r=>{
    const diff=r.new_rate-r.original_rate;const pct=((diff/r.original_rate)*100).toFixed(1);
    const cls=diff>0?'change-pos':diff<0?'change-neg':'change-zero';
    const sign=diff>0?'+':'';
    return `<tr><td><strong>${r.room_type}</strong></td><td>$${r.original_rate.toFixed(2)}</td>
      <td><strong>$${r.new_rate.toFixed(2)}</strong></td>
      <td class="${cls}">${sign}$${diff.toFixed(2)} (${sign}${pct}%)</td>
      <td>${r.applied_rules||'<span style="color:var(--muted)">&mdash;</span>'}</td></tr>`;
  }).join('');
}

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

/* ── change log ── */
let _clData=[],_clFilter='changes';
async function loadChangelog(){
  _clData=await api('/api/changelog');
  renderChangelog();
}
function setClFilter(f){
  _clFilter=f;
  document.querySelectorAll('#cl-toggle button').forEach(b=>{
    b.classList.toggle('active',b.dataset.filter===f);
  });
  renderChangelog();
}
function toggleCycle(cycleNum){
  const group=document.querySelector(`[data-cycle="${cycleNum}"]`);
  if(!group) return;
  const isOpen=group.classList.toggle('open');
  document.querySelectorAll(`.cl-detail[data-parent="${cycleNum}"]`).forEach(r=>{
    r.classList.toggle('visible',isOpen);
  });
}
function renderChangelog(){
  const cycles=_clFilter==='changes'?_clData.filter(c=>c.has_changes):_clData;
  const totalCycles=_clData.length;
  const changeCycles=_clData.filter(c=>c.has_changes).length;
  const noChangeCycles=totalCycles-changeCycles;
  document.getElementById('cl-stats').innerHTML=
    `<div class="cl-stat"><strong>${totalCycles}</strong> total cycles</div>`
    +`<div class="cl-stat"><strong>${changeCycles}</strong> with changes</div>`
    +`<div class="cl-stat"><strong>${noChangeCycles}</strong> no change</div>`;
  const tb=document.querySelector('#cl-table tbody');
  if(!cycles.length){
    tb.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">No entries to display</td></tr>';
    return;
  }
  let html='';
  for(const c of cycles){
    if(!c.has_changes){
      /* no-change row — simple dim row, no expand */
      html+=`<tr class="cl-nochange">
        <td></td>
        <td><span class="cl-cycle-num">#${c.cycle}</span></td>
        <td>${esc(c.timestamp)}</td>
        <td style="color:var(--muted)">No actionable conditions detected</td>
        <td style="color:var(--muted)">&mdash;</td>
      </tr>`;
      continue;
    }
    /* build summary description */
    const n=c.changes.length;
    const rooms=[...new Set(c.changes.map(ch=>ch.room_type))];
    const summaryText=n===1
      ? c.changes[0].description
      : `${n} rate adjustments across ${rooms.join(', ')}`;
    /* build impact column */
    const pcts=c.changes.map(ch=>ch.change_pct);
    let impactHtml='';
    if(n===1){
      const p=pcts[0];
      const cls=p>0?'cl-pct-up':'cl-pct-down';
      const sign=p>0?'+':'';
      impactHtml=`<span class="${cls}">${sign}${p}%</span>`;
    } else {
      const mn=Math.min(...pcts), mx=Math.max(...pcts);
      const fmtP=v=>{const cls=v>0?'cl-pct-up':'cl-pct-down';const s=v>0?'+':'';return `<span class="${cls}">${s}${v}%</span>`;};
      impactHtml=mn===mx?fmtP(mn):`${fmtP(mn)} to ${fmtP(mx)}`;
    }
    /* collapsed group row */
    html+=`<tr class="cl-group" data-cycle="${c.cycle}" onclick="toggleCycle(${c.cycle})">
      <td><span class="cl-chevron">&#9654;</span></td>
      <td><span class="cl-cycle-num">#${c.cycle}</span></td>
      <td>${esc(c.timestamp)}</td>
      <td><div class="cl-summary">${esc(summaryText)}</div></td>
      <td class="cl-impact">${impactHtml}</td>
    </tr>`;
    /* expanded detail rows (hidden by default) */
    for(const ch of c.changes){
      const cls=ch.change_pct>0?'cl-pct-up':'cl-pct-down';
      const sign=ch.change_pct>0?'+':'';
      const rateHtml=`$${ch.original_rate.toFixed(2)} <span class="cl-rate-arrow">&rarr;</span> <strong>$${ch.new_rate.toFixed(2)}</strong> `
        +`<span class="${cls}">${sign}${ch.change_pct}%</span>`;
      html+=`<tr class="cl-detail" data-parent="${c.cycle}">
        <td></td>
        <td><span class="cl-room-badge">${esc(ch.room_type)}</span></td>
        <td colspan="2"><div class="cl-desc">${esc(ch.description)}</div></td>
        <td class="cl-impact">${rateHtml}</td>
      </tr>`;
    }
  }
  tb.innerHTML=html;
}

/* ── init: no auto-load — wait for login ── */
</script>
</body>
</html>"""


# ═══════════════════════════════════════════════════════════════════════════════
# WEB SERVER LAUNCHER
# ═══════════════════════════════════════════════════════════════════════════════

def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def start_web_app(port: int = 0) -> None:
    """Launch the interactive MAYA dashboard in the default browser."""
    if port == 0:
        port = _find_free_port()

    _Handler.state = AppState()
    server = http.server.HTTPServer(("localhost", port), _Handler)
    url = f"http://localhost:{port}"

    print(f"\n  MAYA Dashboard running at  \033[1;36m{url}\033[0m")
    print("  Press Ctrl+C to stop.\n")
    if os.environ.get("MAYA_NO_BROWSER") != "1":
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        server.server_close()


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import sys
    _port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    start_web_app(port=_port)
