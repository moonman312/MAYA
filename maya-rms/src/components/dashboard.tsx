"use client";

import { PropertySelect } from "@/components/property-select";
import { formatUtcMonthYear } from "@/lib/calendar-month-label";
import { SAMPLE_RESERVATIONS } from "@/lib/demo-data";
import type {
  CalendarResponse,
  ChangelogCycle,
  RuleConfig,
  SimulationResult,
} from "@/types/domain";
import { useCallback, useEffect, useMemo, useState } from "react";

type TabKey = "calendar" | "rules" | "simulator" | "changelog" | "pms";

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

function MewsStatusBadge({ status }: { status: string | null }) {
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
    <span className={`rounded px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

export function Dashboard() {
  const [tab, setTab] = useState<TabKey>("calendar");
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [month, setMonth] = useState(new Date().getUTCMonth() + 1);

  const [rules, setRules] = useState<RuleConfig[]>([]);
  const [roomTypeOptions, setRoomTypeOptions] = useState<
    { id: string; name: string }[]
  >([]);
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [simResults, setSimResults] = useState<SimulationResult[]>([]);
  const [changelog, setChangelog] = useState<ChangelogCycle[]>([]);
  const [changesOnly, setChangesOnly] = useState(true);
  const [loading, setLoading] = useState(false);

  const [mewsConnection, setMewsConnection] = useState<{
    configured: boolean;
    status: string | null;
    lastSyncAt: string | null;
    lastTestedAt: string | null;
  } | null>(null);

  const [accessibleHotels, setAccessibleHotels] = useState<
    { id: string; name: string }[]
  >([]);
  const [activeHotelId, setActiveHotelId] = useState<string | null>(null);
  const [hotelSwitching, setHotelSwitching] = useState(false);

  const [ruleName, setRuleName] = useState("");
  const [conditionsText, setConditionsText] = useState(
    "occupancy_percentage:>80",
  );
  const [adjPercent, setAdjPercent] = useState("10");
  const [adjDollars, setAdjDollars] = useState("");
  const [selectedRoomTypeIds, setSelectedRoomTypeIds] = useState<string[]>([]);

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
        const res = await fetch("/api/pms/mews/connection");
        if (!res.ok) {
          setMewsConnection(null);
          return;
        }
        const data = (await res.json()) as {
          configured: boolean;
          status: string | null;
          lastSyncAt: string | null;
          lastTestedAt: string | null;
        };
        setMewsConnection(data);
      } catch {
        setMewsConnection(null);
      }
    })();
  }, [tab, activeHotelId]);

  const reloadCalendar = useCallback(async () => {
    setLoading(true);
    setSelectedDay(null);
    try {
      const data = await api<CalendarResponse>(
        `/api/calendar/${year}/${month}`,
      );
      setCalendar(data);
    } finally {
      setLoading(false);
    }
  }, [month, year]);

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

  async function reloadRules() {
    const data = await api<RuleConfig[]>("/api/rules");
    setRules(data);
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

  function parseConditionsInput(text: string): RuleConfig["conditions"] {
    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const conditions: RuleConfig["conditions"] = {};
    lines.forEach((line) => {
      const [key, val] = line.split(":");
      if (!key || !val) return;
      conditions[key.trim()] = val.trim();
    });
    return conditions;
  }

  async function onCreateRule(e: React.FormEvent) {
    e.preventDefault();
    const action: RuleConfig["action"] = {};
    if (adjPercent.trim() !== "")
      action.adjust_rate_percent = Number(adjPercent);
    if (adjDollars.trim() !== "")
      action.adjust_rate_dollars = Number(adjDollars);
    if (Object.keys(action).length === 0) return;

    const allSelected =
      roomTypeOptions.length > 0 &&
      selectedRoomTypeIds.length === roomTypeOptions.length;
    const affected_room_type_ids = allSelected
      ? roomTypeOptions.map((r) => r.id)
      : selectedRoomTypeIds.slice();
    if (affected_room_type_ids.length === 0) return;

    const room_types = roomTypeOptions
      .filter((r) => affected_room_type_ids.includes(r.id))
      .map((r) => r.name);

    await api("/api/rules", {
      method: "POST",
      body: JSON.stringify({
        rule_name: ruleName,
        conditions: parseConditionsInput(conditionsText),
        action,
        room_types,
        affected_room_type_ids,
      }),
    });

    setRuleName("");
    setConditionsText("occupancy_percentage:>80");
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
  /** Same label as API `month_name`, without `toLocaleString` (avoids SSR/client hydration mismatch). */
  const calendarTitle = formatUtcMonthYear(year, month);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl p-6 md:p-10">
        <header className="mb-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">MAYA RMS</h1>
              <p className="mt-2 text-sm text-slate-300">
                Occupancy, pricing rules, and PMS sync in one place.
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
              <h2 className="text-lg font-semibold">{calendarTitle}</h2>
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
                        const color =
                          data.occupancy_pct >= calendar.thresholds.high
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

                  {selectedDay ? (
                    <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
                      <h3 className="mb-2 text-base font-semibold">
                        {calendar.days[String(selectedDay)].weekday}, day{" "}
                        {selectedDay}
                      </h3>
                      <p className="mb-4 text-sm text-slate-400">
                        {calendar.days[String(selectedDay)].booked}/
                        {calendar.days[String(selectedDay)].total} rooms ·{" "}
                        {calendar.days[String(selectedDay)].occupancy_pct}%
                        occupancy · room revenue{" "}
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
            <h2 className="text-lg font-semibold">Pricing Rules</h2>
            <form
              onSubmit={onCreateRule}
              className="grid gap-3 rounded border border-slate-800 p-4 md:grid-cols-2"
            >
              <input
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                placeholder="Rule name"
                className="rounded bg-slate-950 p-2 text-sm"
                required
              />
              <div className="flex gap-2">
                <input
                  value={adjPercent}
                  onChange={(e) => setAdjPercent(e.target.value)}
                  placeholder="Percent adjustment"
                  className="w-full rounded bg-slate-950 p-2 text-sm"
                />
                <input
                  value={adjDollars}
                  onChange={(e) => setAdjDollars(e.target.value)}
                  placeholder="Dollar adjustment"
                  className="w-full rounded bg-slate-950 p-2 text-sm"
                />
              </div>
              <textarea
                value={conditionsText}
                onChange={(e) => setConditionsText(e.target.value)}
                className="min-h-24 rounded bg-slate-950 p-2 text-sm md:col-span-2"
                placeholder={"occupancy_percentage:>80\nbooking_window:<3"}
              />
              <div className="md:col-span-2">
                <p className="mb-2 text-xs text-slate-400">
                  Apply to room types
                </p>
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
              <button
                type="submit"
                className="cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 md:col-span-2"
              >
                Add Rule
              </button>
            </form>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-300">
                    <th className="py-2">Name</th>
                    <th className="py-2">Conditions</th>
                    <th className="py-2">Scope</th>
                    <th className="py-2">Action</th>
                    <th className="py-2">Status</th>
                    <th className="py-2">Ops</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id} className="border-b border-slate-800">
                      <td className="py-2 pr-3">{rule.rule_name}</td>
                      <td className="py-2 pr-3">
                        {Object.entries(rule.conditions)
                          .map(([k, v]) => `${k} ${String(v)}`)
                          .join(" | ")}
                      </td>
                      <td className="py-2 pr-3">
                        {rule.room_types.length
                          ? rule.room_types.join(", ")
                          : "All"}
                      </td>
                      <td className="py-2 pr-3">
                        {rule.action.adjust_rate_percent !== undefined &&
                          `${rule.action.adjust_rate_percent}% `}
                        {rule.action.adjust_rate_dollars !== undefined &&
                          `$${rule.action.adjust_rate_dollars}`}
                      </td>
                      <td className="py-2 pr-3">
                        {rule.enabled ? "Enabled" : "Disabled"}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex gap-2">
                          <button
                            className="cursor-pointer rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
                            onClick={() => onToggleRule(rule.id)}
                          >
                            Toggle
                          </button>
                          <button
                            className="cursor-pointer rounded bg-rose-700 px-2 py-1 text-xs hover:bg-rose-600"
                            onClick={() => onDeleteRule(rule.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                          Cycle #{cycle.cycle}
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
                      <ul className="mt-2 space-y-1 text-sm text-slate-200">
                        {cycle.changes.map((ch, idx) => (
                          <li key={`${cycle.cycle}-${idx}`}>
                            {ch.room_type}: ${ch.original_rate.toFixed(2)} - {">"}{" "}
                            ${ch.new_rate.toFixed(2)} (
                            {ch.change_pct >= 0 ? "+" : ""}
                            {ch.change_pct}%)
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-slate-300">
                        No actionable conditions detected.
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
            <h2 className="text-lg font-semibold">PMS (Mews)</h2>
            <p className="text-sm text-slate-300">
              Reservations sync on a schedule from your Supabase project (Edge
              Function + cron). Manual sync was removed in favor of automation.
            </p>
            {!activeHotelId ? (
              <p className="text-sm text-slate-400">Select a property to view status.</p>
            ) : mewsConnection === null ? (
              <p className="text-sm text-slate-400">Loading connection status…</p>
            ) : !mewsConnection.configured ? (
              <p className="text-sm text-amber-200/90">
                No Mews integration is configured for this property yet (
                <code className="text-xs">pms_connections</code>).
              </p>
            ) : (
              <div className="space-y-3 rounded border border-slate-800 bg-slate-950 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Mews connection
                  </span>
                  <MewsStatusBadge status={mewsConnection.status} />
                </div>
                <dl className="grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-slate-500">Last sync</dt>
                    <dd>
                      {mewsConnection.lastSyncAt
                        ? formatDisplayTime(mewsConnection.lastSyncAt)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Last tested</dt>
                    <dd>
                      {mewsConnection.lastTestedAt
                        ? formatDisplayTime(mewsConnection.lastTestedAt)
                        : "—"}
                    </dd>
                  </div>
                </dl>
                <p className="text-xs text-slate-500">
                  Status updates when a scheduled sync completes successfully.
                  If syncs fail, timestamps may stop moving even if the status
                  still shows connected.
                </p>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
