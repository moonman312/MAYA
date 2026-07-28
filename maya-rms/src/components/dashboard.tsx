"use client";

import { AskForHelp } from "@/components/onboarding/ask-for-help";
import { OnboardingReviewBanner } from "@/components/onboarding/review-banner";
import { useCalendarLive } from "@/lib/use-calendar-live";
import { PropertySelect } from "@/components/property-select";
import { formatUtcLongDate } from "@/lib/calendar-month-label";
import { SAMPLE_RESERVATIONS } from "@/lib/demo-data";
import { BOOKING_SPEED_LEVELS } from "@/lib/observations/booking-speed";
import {
  conditionRowsToRuleCondition,
  formatRuleConditionsDisplay,
  isRuleActionEmpty,
  isRuleConditionEmpty,
  newConditionRow,
  ruleConditionForInsert,
  ruleConditionToLegacyConditions,
  type ConditionFormRow,
  type ConditionMetric,
} from "@/lib/rule-form";
import type {
  BookingSpeedRuleOperator,
  CalendarResponse,
  ChangelogCycle,
  RuleAction,
  RuleConfig,
  SimulationResult,
} from "@/types/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TabKey = "calendar" | "rules" | "simulator" | "changelog" | "pms";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const tabs: { key: TabKey; label: string }[] = [
  { key: "calendar", label: "Calendar" },
  { key: "rules", label: "Rules" },
  { key: "simulator", label: "Rate Simulator" },
  { key: "changelog", label: "Change Log" },
  { key: "pms", label: "PMS" },
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${url}`);
  }
  return (await res.json()) as T;
}

/** Matches `calendar-store` month grid: Sun-first padding + day cells. */
function CalendarMonthSkeleton({
  year,
  month,
}: {
  year: number;
  month: number;
}) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = firstDay.getUTCDay();

  return (
    <div
      className="grid grid-cols-7 gap-2"
      aria-busy="true"
      aria-label="Loading calendar"
    >
      {Array.from({ length: firstWeekday }).map((_, idx) => (
        <div key={`sk-pad-${idx}`} />
      ))}
      {Array.from({ length: daysInMonth }).map((_, idx) => {
        const dayNum = idx + 1;
        return (
          <div
            key={`sk-${dayNum}`}
            className="animate-pulse rounded border border-slate-800 bg-slate-800/35 p-2"
          >
            <div className="h-3 w-5 rounded bg-slate-700/70" />
            <div className="mt-2 h-7 w-11 rounded bg-slate-700/60" />
            <div className="mt-2 h-3 w-18 rounded bg-slate-600/50" />
            <div className="mt-1 h-3 w-9 rounded bg-slate-600/50" />
            <div className="mt-2 h-1 w-full rounded bg-slate-700/40" />
          </div>
        );
      })}
    </div>
  );
}

function formatDisplayTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

/** Calendar-style line for timelines (Change Log, etc.). */
function formatFriendlyDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

/** Short relative hint for recent instants; null when older than one calendar week. */
function formatRelativeAge(iso: string): string | null {
  try {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return null;
    const ms = Date.now() - then.getTime();
    if (ms < 0) return null;
    const sec = Math.floor(ms / 1000);
    if (sec < 45) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfThen = new Date(then);
    startOfThen.setHours(0, 0, 0, 0);
    const dayDiff = Math.round(
      (startOfToday.getTime() - startOfThen.getTime()) / 86_400_000,
    );
    if (dayDiff === 1) return "yesterday";
    if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} days ago`;
    return null;
  } catch {
    return null;
  }
}

type PmsActivity = {
  connection: {
    pms_type: string;
    status: string | null;
    last_sync_at: string | null;
    last_tested_at: string | null;
  } | null;
  health: {
    state: "healthy" | "degraded" | "down" | "unknown";
    successRate: number | null;
    total: number;
    failures: number;
  };
  log: Array<{
    id: string;
    created_at: string;
    http_method: string;
    endpoint: string;
    status_code: number | null;
    ok: boolean;
    duration_ms: number | null;
    message: string | null;
  }>;
};

function formatPmsName(pmsType: string): string {
  const names: Record<string, string> = {
    cloudbeds: "Cloudbeds",
    mews: "Mews",
    think: "Think Reservations",
    opera: "Opera",
  };
  return names[pmsType] ?? pmsType;
}

function PmsHealthBadge({ health }: { health: PmsActivity["health"] }) {
  const styles: Record<PmsActivity["health"]["state"], { cls: string; label: string }> = {
    healthy: {
      cls: "bg-emerald-600/30 text-emerald-200 ring-1 ring-emerald-500/40",
      label: "Healthy",
    },
    degraded: {
      cls: "bg-amber-600/25 text-amber-100 ring-1 ring-amber-500/35",
      label: "Degraded",
    },
    down: {
      cls: "bg-rose-600/30 text-rose-100 ring-1 ring-rose-500/40",
      label: "Having trouble",
    },
    unknown: {
      cls: "bg-slate-700 text-slate-200 ring-1 ring-slate-600",
      label: "No recent activity",
    },
  };
  const s = styles[health.state];
  return (
    <div className="flex items-center gap-2">
      <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
      {health.total > 0 && health.successRate != null ? (
        <span className="text-[11px] tabular-nums text-slate-500">
          {Math.round(health.successRate * 100)}% of {health.total} requests OK
        </span>
      ) : null}
    </div>
  );
}

/** True when the calendar day is today or later (UTC date semantics). */
function isFutureDay(year: number, month: number, day: number): boolean {
  const target = Date.UTC(year, month - 1, day);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return target >= today;
}

function PmsStatusBadge({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span className="rounded bg-slate-700 px-2 py-0.5 text-xs font-medium text-slate-200">
        unknown
      </span>
    );
  }
  const s = status.toLowerCase();
  const cls =
    s === "connected"
      ? "bg-emerald-600/30 text-emerald-200 ring-1 ring-emerald-500/40"
      : s === "pending"
        ? "bg-amber-600/25 text-amber-100 ring-1 ring-amber-500/35"
        : s === "degraded"
          ? "bg-amber-600/25 text-amber-100 ring-1 ring-amber-500/35"
          : s === "error" || s === "disconnected"
            ? "bg-rose-600/30 text-rose-100 ring-1 ring-rose-500/40"
            : "bg-slate-700 text-slate-200 ring-1 ring-slate-600";
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {status}
    </span>
  );
}

export function Dashboard() {
  const [tab, setTab] = useState<TabKey>("calendar");
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [month, setMonth] = useState(new Date().getUTCMonth() + 1);

  const [rules, setRules] = useState<RuleConfig[]>([]);
  const [fireCounts, setFireCounts] = useState<Record<string, number>>({});
  const [ruleFilter, setRuleFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [roomTypeOptions, setRoomTypeOptions] = useState<
    { id: string; name: string }[]
  >([]);
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [simResults, setSimResults] = useState<SimulationResult[]>([]);
  const [changelog, setChangelog] = useState<ChangelogCycle[]>([]);
  const [changesOnly, setChangesOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [pmsActivity, setPmsActivity] = useState<PmsActivity | null>(null);

  const [accessibleHotels, setAccessibleHotels] = useState<
    { id: string; name: string }[]
  >([]);
  const [activeHotelId, setActiveHotelId] = useState<string | null>(null);
  const [hotelSwitching, setHotelSwitching] = useState(false);

  const [ruleName, setRuleName] = useState("");
  const [condRows, setCondRows] = useState<ConditionFormRow[]>(() => [
    newConditionRow("occupancy"),
  ]);
  const [adjPctEnabled, setAdjPctEnabled] = useState(true);
  const [adjDolEnabled, setAdjDolEnabled] = useState(false);
  const [adjPercent, setAdjPercent] = useState("10");
  const [adjDollars, setAdjDollars] = useState("");
  const [selectedRoomTypeIds, setSelectedRoomTypeIds] = useState<string[]>([]);
  const [ruleFormError, setRuleFormError] = useState<string | null>(null);

  useEffect(() => {
    void reloadRules();
    void reloadRoomTypes();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/hotels");
        if (!res.ok) return;
        const data = (await res.json()) as {
          hotels: { id: string; name: string }[];
          activeHotelId: string | null;
        };
        setAccessibleHotels(data.hotels);
        setActiveHotelId(data.activeHotelId);
      } catch {
        /* demo / offline */
      }
    })();
  }, []);

  useEffect(() => {
    if (tab !== "pms" || !activeHotelId) {
      return;
    }
    void (async () => {
      try {
        const res = await fetch("/api/pms/activity");
        if (!res.ok) {
          setPmsActivity(null);
          return;
        }
        setPmsActivity((await res.json()) as PmsActivity);
      } catch {
        setPmsActivity(null);
      }
    })();
  }, [tab, activeHotelId]);

  // Month responses cached client-side so Prev/Next renders instantly from
  // the last known data, with three guards that keep fast clicking from
  // turning into a request storm (each API call costs auth + several DB
  // round-trips server-side, and bursts can trip upstream rate limits):
  //   - entries fresher than CAL_FRESH_MS aren't refetched at all — the
  //     realtime subscription clears the cache when data actually changes
  //   - at most one in-flight request per month, shared by everything
  //   - neighbor prefetch waits for navigation to settle before firing
  const CAL_FRESH_MS = 2 * 60 * 1000;
  const calendarCacheRef = useRef(
    new Map<string, { data: CalendarResponse; fetchedAt: number }>(),
  );
  const calendarInFlightRef = useRef(new Map<string, Promise<CalendarResponse | null>>());
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calendarCacheKey = useCallback(
    (y: number, m: number) => `${activeHotelId ?? "demo"}|${y}-${m}`,
    [activeHotelId],
  );

  /** Fetch one month with in-flight dedupe; resolves null on failure. */
  const fetchMonth = useCallback(
    (y: number, m: number): Promise<CalendarResponse | null> => {
      const key = calendarCacheKey(y, m);
      const inFlight = calendarInFlightRef.current.get(key);
      if (inFlight) return inFlight;
      const p = api<CalendarResponse>(`/api/calendar/${y}/${m}`)
        .then((data) => {
          calendarCacheRef.current.set(key, { data, fetchedAt: Date.now() });
          return data;
        })
        .catch(() => null)
        .finally(() => calendarInFlightRef.current.delete(key));
      calendarInFlightRef.current.set(key, p);
      return p;
    },
    [calendarCacheKey],
  );

  const prefetchNeighborMonths = useCallback(
    (y: number, m: number) => {
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = setTimeout(() => {
        const neighbors = [
          m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 },
          m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 },
        ];
        for (const n of neighbors) {
          const hit = calendarCacheRef.current.get(calendarCacheKey(n.y, n.m));
          if (hit && Date.now() - hit.fetchedAt < CAL_FRESH_MS) continue;
          void fetchMonth(n.y, n.m);
        }
      }, 400);
    },
    [calendarCacheKey, fetchMonth, CAL_FRESH_MS],
  );

  const reloadCalendar = useCallback(async () => {
    setSelectedDay(null);
    const key = calendarCacheKey(year, month);
    const cached = calendarCacheRef.current.get(key);
    if (cached) {
      // Instant paint from cache; refetch only if it's aged past freshness.
      setCalendar(cached.data);
      prefetchNeighborMonths(year, month);
      if (Date.now() - cached.fetchedAt >= CAL_FRESH_MS) {
        const data = await fetchMonth(year, month);
        if (data) {
          setCalendar(data);
          setLastUpdated(new Date());
        }
      }
      return;
    }
    setLoading(true);
    try {
      const data = await fetchMonth(year, month);
      if (data) {
        setCalendar(data);
        setLastUpdated(new Date());
      }
      prefetchNeighborMonths(year, month);
    } finally {
      setLoading(false);
    }
  }, [month, year, calendarCacheKey, fetchMonth, prefetchNeighborMonths, CAL_FRESH_MS]);

  /**
   * Background refresh used by polling / tab-focus: updates the calendar in
   * place WITHOUT toggling the loading skeleton or clearing the selected day,
   * so prices published by the scheduled cron appear without a visible reload.
   * Errors are swallowed so a transient failure just keeps the current data.
   */
  const reloadCalendarQuiet = useCallback(async () => {
    const data = await fetchMonth(year, month);
    if (data) {
      setCalendar(data);
      setLastUpdated(new Date());
    }
    // On failure, keep showing the last good calendar.
  }, [month, year, fetchMonth]);

  const reloadChangelog = useCallback(async () => {
    const data = await api<ChangelogCycle[]>("/api/changelog");
    setChangelog(data);
  }, []);

  useEffect(() => {
    if (tab === "calendar") {
      void reloadCalendar();
    }
    if (tab === "changelog") {
      void reloadChangelog();
    }
  }, [reloadCalendar, reloadChangelog, tab]);

  // Event-driven refresh: a realtime subscription fires when published_price
  // or reservations change for this hotel, so updates land in ~2s instead of
  // on a polling interval — and nothing refreshes when nothing changed. The
  // slow interval below is only a safety net for environments where realtime
  // isn't enabled on those tables; visibility-change gives a quick catch-up
  // after the browser was backgrounded.
  useCalendarLive(activeHotelId, () => {
    // Real change on the wire: every cached month is now suspect, not just
    // the visible one (a multi-night booking spans months).
    calendarCacheRef.current.clear();
    if (tab === "calendar") void reloadCalendarQuiet();
  });

  useEffect(() => {
    if (tab !== "calendar") return;
    const FALLBACK_POLL_MS = 300_000;
    const id = setInterval(() => {
      void reloadCalendarQuiet();
    }, FALLBACK_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reloadCalendarQuiet();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tab, reloadCalendarQuiet]);

  async function reloadRules() {
    const data = await api<RuleConfig[]>("/api/rules");
    setRules(data);
    try {
      const counts = await api<Record<string, number>>("/api/rules/fire-counts");
      setFireCounts(counts);
    } catch {
      // fire counts are decoration — never block the rules list on them
    }
  }

  async function reloadRoomTypes() {
    const data =
      await api<Array<{ id: string; name: string }>>("/api/room-types");
    setRoomTypeOptions(data);
    setSelectedRoomTypeIds(data.map((item) => item.id));
  }

  async function applyActiveHotel(hotelId: string) {
    if (!hotelId || hotelId === activeHotelId) return;
    setHotelSwitching(true);
    setSelectedDay(null);
    calendarCacheRef.current.clear();
    try {
      const res = await fetch("/api/hotels/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId }),
      });
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        console.error(errBody.error ?? res.statusText);
        return;
      }
      setActiveHotelId(hotelId);
      await Promise.all([reloadRules(), reloadRoomTypes()]);
      if (tab === "calendar") await reloadCalendar();
      if (tab === "changelog") await reloadChangelog();
    } finally {
      setHotelSwitching(false);
    }
  }

  async function runSimulation() {
    const payload = { reservations: SAMPLE_RESERVATIONS };
    const data = await api<SimulationResult[]>("/api/simulate", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setSimResults(data);
  }

  async function onToggleRule(ruleId: string) {
    await api(`/api/rules/${ruleId}/toggle`, { method: "POST" });
    await reloadRules();
  }

  async function onDeleteRule(ruleId: string) {
    await api(`/api/rules/${ruleId}`, { method: "DELETE" });
    await reloadRules();
  }

  function addConditionRow() {
    const used = new Set(condRows.map((r) => r.metric));
    const next: ConditionMetric | undefined = (
      ["occupancy", "booking_speed", "booking_window"] as const
    ).find((m) => !used.has(m));
    if (!next) return;
    setCondRows((prev) => [...prev, newConditionRow(next)]);
  }

  function removeConditionRow(id: string) {
    setCondRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      return next.length ? next : [newConditionRow("occupancy")];
    });
  }

  function updateCondRow(id: string, patch: Partial<ConditionFormRow>) {
    setCondRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  }

  const roomTypeSummary = useMemo(() => {
    const n = roomTypeOptions.length;
    const k = selectedRoomTypeIds.length;
    if (n === 0) return "No room types loaded";
    if (k === 0) return "None selected";
    if (k === n) return "All room types";
    return `${k} of ${n} room types`;
  }, [roomTypeOptions.length, selectedRoomTypeIds.length]);

  async function onCreateRule(e: React.FormEvent) {
    e.preventDefault();
    setRuleFormError(null);

    const rc = ruleConditionForInsert(conditionRowsToRuleCondition(condRows));
    if (isRuleConditionEmpty(rc)) {
      setRuleFormError(
        "Add at least one condition with a valid operator and threshold.",
      );
      return;
    }

    const action: RuleAction = {};
    if (adjPctEnabled) {
      const p = adjPercent.trim();
      if (p === "") {
        setRuleFormError("Enter a percentage adjustment, or turn off %.");
        return;
      }
      const n = Number(p);
      if (!Number.isFinite(n)) {
        setRuleFormError("Percentage must be a number.");
        return;
      }
      action.adjust_rate_percent = n;
    }
    if (adjDolEnabled) {
      const p = adjDollars.trim();
      if (p === "") {
        setRuleFormError("Enter a dollar adjustment, or turn off $.");
        return;
      }
      const n = Number(p);
      if (!Number.isFinite(n)) {
        setRuleFormError("Dollar amount must be a number.");
        return;
      }
      action.adjust_rate_dollars = n;
    }
    if (isRuleActionEmpty(action)) {
      setRuleFormError("Enable at least one rate adjustment (% or $).");
      return;
    }

    const allSelected =
      roomTypeOptions.length > 0 &&
      selectedRoomTypeIds.length === roomTypeOptions.length;
    const affected_room_type_ids = allSelected
      ? roomTypeOptions.map((r) => r.id)
      : selectedRoomTypeIds.slice();
    if (affected_room_type_ids.length === 0) {
      setRuleFormError("Select at least one room type.");
      return;
    }

    const room_types = roomTypeOptions
      .filter((r) => affected_room_type_ids.includes(r.id))
      .map((r) => r.name);

    const legacyConditions = ruleConditionToLegacyConditions(rc);

    await api("/api/rules", {
      method: "POST",
      body: JSON.stringify({
        rule_name: ruleName,
        condition: rc,
        conditions: legacyConditions,
        action,
        room_types,
        affected_room_type_ids,
      }),
    });

    setRuleName("");
    setCondRows([newConditionRow("occupancy")]);
    setAdjPctEnabled(true);
    setAdjDolEnabled(false);
    setAdjPercent("10");
    setAdjDollars("");
    setSelectedRoomTypeIds(roomTypeOptions.map((r) => r.id));
    await reloadRules();
  }

  const visibleCycles = useMemo(
    () => (changesOnly ? changelog.filter((c) => c.has_changes) : changelog),
    [changesOnly, changelog],
  );

  const calendarBusy = loading || hotelSwitching;

  // Year options come from the property's actual data range when the API
  // reports one; otherwise a sensible window around the current year.
  const calendarYears = useMemo(() => {
    const nowYear = new Date().getUTCFullYear();
    const minYear = calendar?.range?.min
      ? Number(calendar.range.min.slice(0, 4))
      : nowYear - 2;
    const maxYear = calendar?.range?.max
      ? Number(calendar.range.max.slice(0, 4))
      : nowYear + 1;
    const years: number[] = [];
    for (let y = Math.min(minYear, year); y <= Math.max(maxYear, year); y++) years.push(y);
    return years;
  }, [calendar?.range?.min, calendar?.range?.max, year]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl p-6 md:p-10">
        <header className="mb-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">MAYA</h1>
              <p className="mt-2 text-sm text-slate-300">
                Machine Assisted Yield Automation
              </p>
              <p className="text-sm text-slate-500">
                Dynamic Pricing That Leaves You In Control
              </p>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <form action="/auth/logout" method="post">
                <button
                  type="submit"
                  className="w-full cursor-pointer rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 sm:w-auto"
                >
                  Sign Out
                </button>
              </form>
            </div>
          </div>
        </header>

        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <nav className="flex flex-wrap gap-2">
            {tabs.map((item) => (
              <button
                key={item.key}
                className={`cursor-pointer rounded-md px-4 py-2 text-sm font-medium transition ${
                  tab === item.key
                    ? "bg-sky-500 text-white"
                    : "bg-slate-800 hover:bg-slate-700"
                }`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {accessibleHotels.length > 0 ? (
            <div className="sm:shrink-0">
              <PropertySelect
                id="header-property"
                options={accessibleHotels}
                value={activeHotelId}
                disabled={hotelSwitching}
                onValueChange={(id) => void applyActiveHotel(id)}
              />
            </div>
          ) : null}
        </div>

        <OnboardingReviewBanner />

        {tab === "calendar" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center gap-3">
              <button
                className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
                onClick={() => {
                  const m = month - 1;
                  if (m < 1) {
                    setMonth(12);
                    setYear((y) => y - 1);
                  } else {
                    setMonth(m);
                  }
                }}
              >
                Prev
              </button>
              <div className="flex items-center gap-1.5">
                <select
                  aria-label="Month"
                  value={month}
                  onChange={(e) => {
                    setSelectedDay(null);
                    setMonth(Number(e.target.value));
                  }}
                  className="cursor-pointer rounded bg-slate-800 px-2 py-1.5 text-sm font-semibold hover:bg-slate-700"
                >
                  {MONTH_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Year"
                  value={year}
                  onChange={(e) => {
                    setSelectedDay(null);
                    setYear(Number(e.target.value));
                  }}
                  className="cursor-pointer rounded bg-slate-800 px-2 py-1.5 text-sm font-semibold hover:bg-slate-700"
                >
                  {calendarYears.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
                onClick={() => {
                  const m = month + 1;
                  if (m > 12) {
                    setMonth(1);
                    setYear((y) => y + 1);
                  } else {
                    setMonth(m);
                  }
                }}
              >
                Next
              </button>
              <span
                className="ml-auto text-xs text-slate-500"
                title="Updates the moment prices or bookings change"
              >
                {lastUpdated
                  ? `Updated ${lastUpdated.toLocaleTimeString()} · live`
                  : "Loading…"}
              </span>
            </div>

            {calendarBusy ? (
              <CalendarMonthSkeleton year={year} month={month} />
            ) : (
              calendar && (
                <>
                  <div className="grid grid-cols-7 gap-2">
                    {Array.from({ length: calendar.first_weekday }).map(
                      (_, idx) => (
                        <div key={`empty-${idx}`} />
                      ),
                    )}
                    {Array.from({ length: calendar.days_in_month }).map(
                      (_, idx) => {
                        const day = idx + 1;
                        const data = calendar.days[String(day)];
                        // Colors are property-relative RevPAR terciles from the
                        // API; fall back to the legacy occupancy cutoffs for
                        // payloads that predate them.
                        const color = data.color
                          ? { green: "bg-emerald-600", orange: "bg-amber-500", red: "bg-rose-600" }[
                              data.color
                            ]
                          : data.occupancy_pct >= calendar.thresholds.high
                            ? "bg-emerald-600"
                            : data.occupancy_pct >= calendar.thresholds.low
                              ? "bg-amber-500"
                              : "bg-rose-600";
                        return (
                          <button
                            key={day}
                            type="button"
                            className={`cursor-pointer rounded border border-slate-700 p-2 text-left hover:border-sky-400 ${
                              selectedDay === day ? "ring-2 ring-sky-400" : ""
                            }`}
                            onClick={() => setSelectedDay(day)}
                          >
                            <div className="text-xs text-slate-400">{day}</div>
                            <div className="text-lg font-semibold">
                              {data.occupancy_pct}%
                            </div>
                            <div className="mt-1 text-[11px] text-slate-400">
                              {data.booked}/{data.total} rooms
                            </div>
                            <div
                              className="text-[11px] text-slate-400"
                              title="Room revenue (booked nights)"
                            >
                              $
                              {data.revenue >= 1000
                                ? `${(data.revenue / 1000).toFixed(1)}k`
                                : data.revenue.toFixed(0)}
                            </div>
                            <div
                              className={`mt-2 h-1 w-full rounded ${color}`}
                            />
                          </button>
                        );
                      },
                    )}
                  </div>

                  <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-1 w-4 rounded bg-emerald-600" />
                      strong night
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-1 w-4 rounded bg-amber-500" />
                      typical night
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-1 w-4 rounded bg-rose-600" />
                      weak night
                    </span>
                    <span>
                      — measured by revenue per room, relative to this
                      property&apos;s own results (future nights compare
                      against other upcoming nights)
                    </span>
                  </p>

                  {selectedDay ? (
                    <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
                      <h3 className="mb-2 text-base font-semibold">
                        {calendar.days[String(selectedDay)].weekday},{" "}
                        {formatUtcLongDate(year, month, selectedDay)}
                      </h3>
                      <p className="mb-4 text-sm text-slate-400">
                        {calendar.days[String(selectedDay)].booked}/
                        {calendar.days[String(selectedDay)].total} rooms ·{" "}
                        {calendar.days[String(selectedDay)].occupancy_pct}%
                        occupancy ·{" "}
                        {isFutureDay(year, month, selectedDay)
                          ? "revenue on the books"
                          : "revenue"}{" "}
                        <span className="font-medium text-slate-200">
                          $
                          {calendar.days[
                            String(selectedDay)
                          ].revenue.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </p>
                      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                        {calendar.days[String(selectedDay)].room_types.map(
                          (rt) => (
                            <div
                              key={rt.id}
                              className="rounded border border-slate-800 p-3"
                            >
                              <p className="font-medium">{rt.name}</p>
                              <p className="mt-1 text-sm text-slate-300">
                                Booked {rt.booked}/{rt.total_rooms}
                              </p>
                              <p className="text-sm text-slate-300">
                                ADR ${rt.rate.toFixed(2)}
                              </p>
                              <p className="text-sm text-sky-300">
                                Current price{" "}
                                {(rt.current_rate ?? rt.current_price) != null
                                  ? `$${(rt.current_rate ?? rt.current_price)!.toFixed(2)}`
                                  : "—"}
                              </p>
                              <p className="text-sm text-slate-300">
                                Revenue ${rt.revenue.toFixed(2)}
                              </p>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  ) : null}
                </>
              )
            )}
          </section>
        )}

        {tab === "rules" && (
          <section className="space-y-5 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <h2 className="text-lg font-semibold">Pricing Rules</h2>
                <AskForHelp />
              </div>
              <div className="flex items-center gap-1 rounded-full border border-slate-800 bg-slate-950 p-1">
                {(["all", "enabled", "disabled"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setRuleFilter(f)}
                    className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      ruleFilter === f
                        ? "bg-slate-700 text-slate-100"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-300">
                    <th className="py-2">Name</th>
                    <th className="py-2">Fired</th>
                    <th className="py-2">Conditions</th>
                    <th className="py-2">Room Types</th>
                    <th className="py-2">Price Change</th>
                    <th className="py-2">Status</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rules
                    .filter((rule) =>
                      ruleFilter === "all"
                        ? true
                        : ruleFilter === "enabled"
                          ? rule.enabled
                          : !rule.enabled,
                    )
                    .sort(
                      (a, b) =>
                        (fireCounts[b.id] ?? 0) - (fireCounts[a.id] ?? 0) ||
                        Number(b.enabled) - Number(a.enabled) ||
                        a.rule_name.localeCompare(b.rule_name),
                    )
                    .map((rule) => (
                    <tr key={rule.id} className="border-b border-slate-800">
                      <td className="py-2 pr-3 font-medium text-slate-200">
                        {rule.rule_name}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {fireCounts[rule.id] ? (
                          <span className="font-semibold text-sky-300">
                            {fireCounts[rule.id]}×
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {formatRuleConditionsDisplay(rule.conditions)}
                      </td>
                      <td className="py-2 pr-3">
                        {rule.room_types.length
                          ? rule.room_types.join(", ")
                          : "All"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {rule.action.adjust_rate_percent !== undefined &&
                          `${rule.action.adjust_rate_percent > 0 ? "+" : ""}${rule.action.adjust_rate_percent}% `}
                        {rule.action.adjust_rate_dollars !== undefined &&
                          `${rule.action.adjust_rate_dollars < 0 ? "-" : "+"}$${Math.abs(rule.action.adjust_rate_dollars)}`}
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={rule.enabled}
                          aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.rule_name}`}
                          onClick={() => onToggleRule(rule.id)}
                          className="group inline-flex cursor-pointer items-center gap-2"
                        >
                          <span
                            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                              rule.enabled ? "bg-emerald-500" : "bg-slate-700"
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform ${
                                rule.enabled ? "translate-x-[18px]" : "translate-x-0.5"
                              }`}
                            />
                          </span>
                          <span
                            className={`text-xs font-medium ${
                              rule.enabled ? "text-emerald-300" : "text-slate-500"
                            }`}
                          >
                            {rule.enabled ? "On" : "Off"}
                          </span>
                        </button>
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          className="cursor-pointer rounded bg-rose-700 px-2 py-1 text-xs hover:bg-rose-600"
                          onClick={() => onDeleteRule(rule.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded border border-slate-800 bg-slate-950/40">
              <button
                type="button"
                onClick={() => setRuleFormOpen((o) => !o)}
                aria-expanded={ruleFormOpen}
                className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-medium text-slate-300">
                  + Add a rule
                </span>
                <span
                  className={`text-slate-500 transition-transform duration-200 ${
                    ruleFormOpen ? "rotate-180" : ""
                  }`}
                  aria-hidden
                >
                  ▾
                </span>
              </button>
              {ruleFormOpen ? (
            <form
              onSubmit={onCreateRule}
              className="space-y-4 border-t border-slate-800 p-4"
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-slate-400">
                    Rule name
                  </label>
                  <input
                    value={ruleName}
                    onChange={(e) => setRuleName(e.target.value)}
                    placeholder="e.g. Weekend surge"
                    className="w-full rounded bg-slate-950 p-2 text-sm"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <p className="mb-2 text-xs font-medium text-slate-400">
                    Conditions
                  </p>
                  <p className="mb-3 text-xs text-slate-500">
                    Matches when <span className="text-slate-400">all</span> of
                    the following are true.
                  </p>
                  <div className="flex flex-col gap-3">
                    {condRows.map((row) => {
                      const taken = new Set(
                        condRows
                          .filter((r) => r.id !== row.id)
                          .map((r) => r.metric),
                      );
                      return (
                        <div
                          key={row.id}
                          className="rounded border border-slate-800 bg-slate-950/80 p-3"
                        >
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,16rem)_minmax(0,10rem)_minmax(0,10rem)_auto] sm:items-end">
                            <div className="min-w-0">
                              <label className="mb-0.5 block text-[11px] text-slate-500">
                                Metric
                              </label>
                              <select
                                value={row.metric}
                                className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                onChange={(e) => {
                                  const m = e.target.value as ConditionMetric;
                                  updateCondRow(row.id, {
                                    metric: m,
                                    value:
                                      m === "occupancy"
                                        ? "80"
                                        : m === "booking_window"
                                          ? "7"
                                          : "5",
                                    pickup_window_days: 3,
                                    pickup_metric: "room_nights",
                                    booking_speed_operator: "at_least",
                                    booking_speed_level: "faster",
                                    booking_speed_window_days: 7,
                                  });
                                }}
                              >
                                <option
                                  value="occupancy"
                                  disabled={taken.has("occupancy")}
                                >
                                  Occupancy (%)
                                </option>
                                <option
                                  value="booking_speed"
                                  disabled={taken.has("booking_speed")}
                                >
                                  Booking speed (vs. normal pace)
                                </option>
                                <option
                                  value="booking_window"
                                  disabled={taken.has("booking_window")}
                                >
                                  Booking window (days to stay)
                                </option>
                              </select>
                            </div>
                            {row.metric === "booking_speed" ? (
                              <>
                                <div>
                                  <label className="mb-0.5 block text-[11px] text-slate-500">
                                    Compare
                                  </label>
                                  <select
                                    value={row.booking_speed_operator}
                                    className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                    onChange={(e) =>
                                      updateCondRow(row.id, {
                                        booking_speed_operator: e.target
                                          .value as BookingSpeedRuleOperator,
                                      })
                                    }
                                  >
                                    <option value="at_least">At least</option>
                                    <option value="is">Exactly</option>
                                    <option value="at_most">At most</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="mb-0.5 block text-[11px] text-slate-500">
                                    Speed
                                  </label>
                                  <select
                                    value={row.booking_speed_level}
                                    className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                    onChange={(e) =>
                                      updateCondRow(row.id, {
                                        booking_speed_level: e.target.value,
                                      })
                                    }
                                  >
                                    {BOOKING_SPEED_LEVELS.map((l) => (
                                      <option key={l.key} value={l.key}>
                                        {l.label}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </>
                            ) : (
                              <>
                                <div>
                                  <label className="mb-0.5 block text-[11px] text-slate-500">
                                    Compare
                                  </label>
                                  <select
                                    value={row.operator}
                                    className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                    onChange={(e) =>
                                      updateCondRow(row.id, {
                                        operator: e.target.value as "gt" | "lt",
                                      })
                                    }
                                  >
                                    <option value="gt">Greater than</option>
                                    <option value="lt">Less than</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="mb-0.5 block text-[11px] text-slate-500">
                                    Threshold
                                  </label>
                                  <input
                                    type="number"
                                    step="any"
                                    className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                    value={row.value}
                                    onChange={(e) =>
                                      updateCondRow(row.id, {
                                        value: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                              </>
                            )}
                            <div className="flex justify-end sm:justify-end">
                              <button
                                type="button"
                                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-red-800 bg-transparent text-lg leading-none text-red-800 hover:bg-red-950/30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-800"
                                onClick={() => removeConditionRow(row.id)}
                                aria-label="Remove condition"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                          {row.metric === "pickup" ? (
                            <div className="mt-3 grid gap-2 border-t border-slate-800 pt-3 sm:grid-cols-2">
                              <div>
                                <label className="mb-0.5 block text-[11px] text-slate-500">
                                  Lookback window
                                </label>
                                <select
                                  className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                  value={String(row.pickup_window_days)}
                                  onChange={(e) =>
                                    updateCondRow(row.id, {
                                      pickup_window_days: Number(
                                        e.target.value,
                                      ) as 1 | 3 | 7,
                                    })
                                  }
                                >
                                  <option value="1">1 day</option>
                                  <option value="3">3 days</option>
                                  <option value="7">7 days</option>
                                </select>
                              </div>
                              <div>
                                <label className="mb-0.5 block text-[11px] text-slate-500">
                                  Pickup measures
                                </label>
                                <select
                                  className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                  value={row.pickup_metric}
                                  onChange={(e) =>
                                    updateCondRow(row.id, {
                                      pickup_metric: e.target.value as
                                        | "room_nights"
                                        | "revenue",
                                    })
                                  }
                                >
                                  <option value="room_nights">
                                    Room nights (units)
                                  </option>
                                  <option value="revenue">
                                    Revenue (currency)
                                  </option>
                                </select>
                              </div>
                            </div>
                          ) : null}
                          {row.metric === "booking_speed" ? (
                            <div className="mt-3 grid gap-2 border-t border-slate-800 pt-3 sm:grid-cols-2">
                              <div>
                                <label className="mb-0.5 block text-[11px] text-slate-500">
                                  Measured over
                                </label>
                                <select
                                  className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                  value={String(row.booking_speed_window_days)}
                                  onChange={(e) =>
                                    updateCondRow(row.id, {
                                      booking_speed_window_days: Number(
                                        e.target.value,
                                      ) as 1 | 7 | 30,
                                    })
                                  }
                                >
                                  <option value="1">Past day</option>
                                  <option value="7">Past week</option>
                                  <option value="30">Past month</option>
                                </select>
                              </div>
                              <p className="self-end pb-2 text-[11px] leading-4 text-slate-500">
                                Compared with how similar past dates were
                                booking when they were this far from arrival.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {condRows.length < 3 ? (
                    <button
                      type="button"
                      className="mt-2 text-xs font-medium text-sky-400 hover:text-sky-300"
                      onClick={addConditionRow}
                    >
                      + Add condition
                    </button>
                  ) : null}
                </div>

                <div className="md:col-span-2">
                  <p className="mb-2 text-xs font-medium text-slate-400">
                    Rate adjustment
                  </p>
                  <p className="mb-3 text-xs text-slate-500">
                    Enable one or both. Percent and dollar both apply when
                    present.
                  </p>
                  <div className="space-y-3 rounded border border-slate-800 bg-slate-950/80 p-3">
                    <label className="flex cursor-pointer flex-wrap items-center gap-3">
                      <input
                        type="checkbox"
                        className="rounded border-slate-600"
                        checked={adjPctEnabled}
                        onChange={(e) => {
                          setAdjPctEnabled(e.target.checked);
                          if (!e.target.checked) setAdjPercent("");
                        }}
                      />
                      <span className="text-sm text-slate-300">
                        Adjust by percent (%)
                      </span>
                      <input
                        type="number"
                        step="any"
                        disabled={!adjPctEnabled}
                        value={adjPercent}
                        onChange={(e) => setAdjPercent(e.target.value)}
                        placeholder="e.g. 10 or -5"
                        className="min-w-32 flex-1 rounded border border-slate-700 bg-slate-950 p-2 text-sm disabled:opacity-40"
                      />
                    </label>
                    <label className="flex cursor-pointer flex-wrap items-center gap-3">
                      <input
                        type="checkbox"
                        className="rounded border-slate-600"
                        checked={adjDolEnabled}
                        onChange={(e) => {
                          setAdjDolEnabled(e.target.checked);
                          if (!e.target.checked) setAdjDollars("");
                        }}
                      />
                      <span className="text-sm text-slate-300">
                        Adjust by fixed amount ($)
                      </span>
                      <input
                        type="number"
                        step="any"
                        disabled={!adjDolEnabled}
                        value={adjDollars}
                        onChange={(e) => setAdjDollars(e.target.value)}
                        placeholder="e.g. 25 or -10"
                        className="min-w-32 flex-1 rounded border border-slate-700 bg-slate-950 p-2 text-sm disabled:opacity-40"
                      />
                    </label>
                  </div>
                </div>

                <div className="md:col-span-2">
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <p className="text-xs font-medium text-slate-400">
                      Apply to room types
                    </p>
                    <span className="text-xs text-slate-500">
                      {roomTypeSummary}
                    </span>
                    <div className="ml-auto flex gap-2">
                      <button
                        type="button"
                        className="cursor-pointer rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
                        onClick={() =>
                          setSelectedRoomTypeIds(
                            roomTypeOptions.map((r) => r.id),
                          )
                        }
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
                        onClick={() => setSelectedRoomTypeIds([])}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {roomTypeOptions.map((opt) => {
                      const on = selectedRoomTypeIds.includes(opt.id);
                      return (
                        <button
                          type="button"
                          key={opt.id}
                          className={`cursor-pointer rounded px-2 py-1 text-xs ${on ? "bg-sky-600" : "bg-slate-800"}`}
                          onClick={() =>
                            setSelectedRoomTypeIds((prev) =>
                              prev.includes(opt.id)
                                ? prev.filter((x) => x !== opt.id)
                                : [...prev, opt.id],
                            )
                          }
                          title={opt.name}
                        >
                          {opt.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {ruleFormError ? (
                <p className="text-sm text-rose-400">{ruleFormError}</p>
              ) : null}

              <button
                type="submit"
                className="cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
              >
                Add Rule
              </button>
            </form>
              ) : null}
            </div>
          </section>
        )}

        {tab === "simulator" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">Rate Simulator</h2>
            <button
              className="cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
              onClick={runSimulation}
            >
              Run Simulation
            </button>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded border border-slate-800 p-3">
                <h3 className="mb-2 text-sm font-semibold">
                  Sample Reservations
                </h3>
                <ul className="space-y-2 text-sm text-slate-300">
                  {SAMPLE_RESERVATIONS.map((r, idx) => (
                    <li key={`${r.room_type}-${idx}`}>
                      {r.room_type}: ${r.current_rate} (occ{" "}
                      {r.occupancy_percentage}% / window {r.booking_window}d /
                      pickup {r.pickup_rate})
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded border border-slate-800 p-3">
                <h3 className="mb-2 text-sm font-semibold">
                  Simulation Results
                </h3>
                {!simResults.length && (
                  <p className="text-sm text-slate-300">
                    Run simulation to view results.
                  </p>
                )}
                <ul className="space-y-2 text-sm text-slate-300">
                  {simResults.map((row, idx) => {
                    const delta = row.new_rate - row.original_rate;
                    const cls =
                      delta > 0
                        ? "text-rose-300"
                        : delta < 0
                          ? "text-emerald-300"
                          : "text-slate-300";
                    return (
                      <li key={`${row.room_type}-${idx}`}>
                        {row.room_type}: ${row.original_rate.toFixed(2)} - {">"}{" "}
                        <span className="font-semibold">
                          ${row.new_rate.toFixed(2)}
                        </span>{" "}
                        <span className={cls}>
                          ({delta >= 0 ? "+" : ""}
                          {delta.toFixed(2)})
                        </span>{" "}
                        [{row.applied_rules || "none"}]
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </section>
        )}

        {tab === "changelog" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Change Log</h2>
              <button
                className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
                onClick={() => setChangesOnly((v) => !v)}
              >
                {changesOnly ? "Show All Cycles" : "Show Changes Only"}
              </button>
            </div>
            <div className="space-y-2">
              {visibleCycles.map((cycle) => {
                const whenRelative = formatRelativeAge(cycle.timestamp);
                return (
                  <div
                    key={cycle.cycle}
                    className="rounded border border-slate-800 p-3"
                  >
                    <p className="text-xs text-slate-400">
                      <time
                        dateTime={cycle.timestamp}
                        title={formatDisplayTime(cycle.timestamp)}
                        className="not-italic"
                      >
                        <span className="font-medium text-slate-300">
                          Pricing run
                        </span>
                        <span className="text-slate-500"> · </span>
                        <span>{formatFriendlyDateTime(cycle.timestamp)}</span>
                        {whenRelative ? (
                          <span className="text-slate-500">
                            {" "}
                            ({whenRelative})
                          </span>
                        ) : null}
                      </time>
                    </p>
                    {cycle.has_changes ? (
                      <ul className="mt-2 space-y-3">
                        {cycle.changes.map((ch, idx) => (
                          <li key={`${cycle.cycle}-${idx}`}>
                            <div className="text-sm font-medium text-slate-200">
                              {ch.room_type}
                              {ch.stay_date ? (
                                <span className="text-slate-400">
                                  {" "}
                                  · stay {ch.stay_date}
                                </span>
                              ) : null}
                              : ${ch.original_rate.toFixed(2)}{" "}
                              {ch.new_rate >= ch.original_rate ? "up" : "down"} to $
                              {ch.new_rate.toFixed(2)} (
                              {ch.change_pct >= 0 ? "+" : ""}
                              {ch.change_pct}%)
                            </div>
                            {(ch.narrative && ch.narrative.length > 0
                              ? ch.narrative
                              : [ch.description]
                            ).map((sentence, si) => (
                              <p
                                key={si}
                                className="mt-0.5 text-[13px] leading-relaxed text-slate-400"
                              >
                                {sentence}
                              </p>
                            ))}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-slate-300">
                        Prices checked — nothing needed to change.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {tab === "pms" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">
              Property System
              {pmsActivity?.connection
                ? ` (${formatPmsName(pmsActivity.connection.pms_type)})`
                : ""}
            </h2>
            <p className="text-sm text-slate-300">
              Bookings sync automatically on a schedule. This page shows how
              that connection is doing.
            </p>
            {!activeHotelId ? (
              <p className="text-sm text-slate-400">
                Select a property to view status.
              </p>
            ) : pmsActivity === null ? (
              <p className="text-sm text-slate-400">Loading connection status…</p>
            ) : !pmsActivity.connection ? (
              <p className="text-sm text-amber-200/90">
                No property system is connected for this property yet.
              </p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5 rounded border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-500">Connection</div>
                    <PmsStatusBadge status={pmsActivity.connection.status} />
                  </div>
                  <div className="space-y-1.5 rounded border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-500">
                      Health (last 24 hours)
                    </div>
                    <PmsHealthBadge health={pmsActivity.health} />
                  </div>
                  <div className="space-y-1.5 rounded border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-500">Last sync</div>
                    <div className="text-sm text-slate-200">
                      {pmsActivity.connection.last_sync_at
                        ? formatDisplayTime(pmsActivity.connection.last_sync_at)
                        : "—"}
                    </div>
                  </div>
                </div>

                <div className="rounded border border-slate-800 bg-slate-950">
                  <div className="border-b border-slate-800 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-400">
                    Recent requests to {formatPmsName(pmsActivity.connection.pms_type)}
                  </div>
                  {pmsActivity.log.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-500">
                      No requests recorded yet — the log fills as syncs run.
                    </p>
                  ) : (
                    <div className="max-h-80 overflow-y-auto">
                      <table className="w-full border-collapse text-xs">
                        <tbody>
                          {pmsActivity.log.map((entry) => (
                            <tr
                              key={entry.id}
                              className="border-b border-slate-800/60 last:border-b-0"
                            >
                              <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">
                                {formatDisplayTime(entry.created_at)}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-slate-400">
                                {entry.http_method}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-slate-300">
                                {entry.endpoint}
                              </td>
                              <td
                                className={`px-2 py-1.5 font-mono ${
                                  entry.ok ? "text-emerald-400" : "text-rose-400"
                                }`}
                              >
                                {entry.status_code ?? "ERR"}
                              </td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">
                                {entry.duration_ms != null ? `${entry.duration_ms}ms` : ""}
                              </td>
                              <td className="max-w-[16rem] truncate px-2 py-1.5 text-slate-500">
                                {entry.message ?? ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
