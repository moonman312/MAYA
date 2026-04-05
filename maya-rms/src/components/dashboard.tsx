"use client";

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
  { key: "pms", label: "PMS (Mews)" },
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

export function Dashboard() {
  const [tab, setTab] = useState<TabKey>("calendar");
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [month, setMonth] = useState(new Date().getUTCMonth() + 1);

  const [rules, setRules] = useState<RuleConfig[]>([]);
  const [roomTypes, setRoomTypes] = useState<string[]>([]);
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [simResults, setSimResults] = useState<SimulationResult[]>([]);
  const [changelog, setChangelog] = useState<ChangelogCycle[]>([]);
  const [changesOnly, setChangesOnly] = useState(true);
  const [loading, setLoading] = useState(false);

  const [pmsLog, setPmsLog] = useState<string[]>([]);
  const [pmsBusy, setPmsBusy] = useState(false);
  const [pmsOverrideJson, setPmsOverrideJson] = useState("");

  function appendPms(line: string) {
    setPmsLog((prev) => [...prev.slice(-100), `${new Date().toISOString()}  ${line}`]);
  }

  async function callPmsApi(path: string) {
    setPmsBusy(true);
    try {
      let bodyStr = "{}";
      if (pmsOverrideJson.trim()) {
        try {
          const parsed = JSON.parse(pmsOverrideJson) as unknown;
          bodyStr = JSON.stringify({ mews: parsed });
        } catch {
          appendPms("ERROR: Advanced JSON is not valid JSON.");
          return;
        }
      }
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!res.ok) {
        appendPms(`ERROR ${res.status}: ${data.error ?? res.statusText}`);
        return;
      }
      appendPms(JSON.stringify(data));
    } catch (e) {
      appendPms(`ERROR ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPmsBusy(false);
    }
  }

  const [ruleName, setRuleName] = useState("");
  const [conditionsText, setConditionsText] = useState("occupancy_percentage:>80");
  const [adjPercent, setAdjPercent] = useState("10");
  const [adjDollars, setAdjDollars] = useState("");
  const [selectedRoomTypes, setSelectedRoomTypes] = useState<string[]>([]);

  useEffect(() => {
    void reloadRules();
    void reloadRoomTypes();
  }, []);

  const reloadCalendar = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<CalendarResponse>(`/api/calendar/${year}/${month}`);
      setCalendar(data);
      setSelectedDay(null);
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
    const data = await api<Array<{ name: string }>>("/api/room-types");
    setRoomTypes(data.map((item) => item.name));
    setSelectedRoomTypes(data.map((item) => item.name));
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
    if (adjPercent.trim() !== "") action.adjust_rate_percent = Number(adjPercent);
    if (adjDollars.trim() !== "") action.adjust_rate_dollars = Number(adjDollars);
    if (Object.keys(action).length === 0) return;

    const allSelected = selectedRoomTypes.length === roomTypes.length;
    await api("/api/rules", {
      method: "POST",
      body: JSON.stringify({
        rule_name: ruleName,
        conditions: parseConditionsInput(conditionsText),
        action,
        room_types: allSelected ? [] : selectedRoomTypes,
      }),
    });

    setRuleName("");
    setConditionsText("occupancy_percentage:>80");
    setAdjPercent("10");
    setAdjDollars("");
    setSelectedRoomTypes(roomTypes);
    await reloadRules();
  }

  const visibleCycles = useMemo(
    () => (changesOnly ? changelog.filter((c) => c.has_changes) : changelog),
    [changesOnly, changelog],
  );

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl p-6 md:p-10">
        <header className="mb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">MAYA RMS</h1>
              <p className="mt-2 text-sm text-slate-300">
                Next.js + Supabase migration with equivalent dashboard workflows from the Python app.
              </p>
            </div>
            <form action="/auth/logout" method="post">
              <button className="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700">
                Sign Out
              </button>
            </form>
          </div>
        </header>

        <nav className="mb-6 flex flex-wrap gap-2">
          {tabs.map((item) => (
            <button
              key={item.key}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                tab === item.key ? "bg-sky-500 text-white" : "bg-slate-800 hover:bg-slate-700"
              }`}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {tab === "calendar" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center gap-3">
              <button
                className="rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
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
              <h2 className="text-lg font-semibold">
                {calendar ? calendar.month_name : `${year}-${String(month).padStart(2, "0")}`}
              </h2>
              <button
                className="rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
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

            {loading && <p className="text-sm text-slate-300">Loading calendar...</p>}
            {calendar && (
              <>
                <div className="grid grid-cols-7 gap-2">
                  {Array.from({ length: calendar.first_weekday }).map((_, idx) => (
                    <div key={`empty-${idx}`} />
                  ))}
                  {Array.from({ length: calendar.days_in_month }).map((_, idx) => {
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
                        className={`rounded border border-slate-700 p-2 text-left hover:border-sky-400 ${
                          selectedDay === day ? "ring-2 ring-sky-400" : ""
                        }`}
                        onClick={() => setSelectedDay(day)}
                      >
                        <div className="text-xs text-slate-400">{day}</div>
                        <div className="text-lg font-semibold">{data.occupancy_pct}%</div>
                        <div className="mt-1 text-[11px] text-slate-400">
                          {data.booked}/{data.total} rooms
                        </div>
                        <div className="text-[11px] text-slate-400">
                          ${data.revenue >= 1000 ? `${(data.revenue / 1000).toFixed(1)}k` : data.revenue.toFixed(0)}
                        </div>
                        <div className={`mt-2 h-1 w-full rounded ${color}`} />
                      </button>
                    );
                  })}
                </div>

                {selectedDay && (
                  <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
                    <h3 className="mb-1 text-base font-semibold">
                      {calendar.days[String(selectedDay)].weekday}, Day {selectedDay}
                    </h3>
                    <p className="mb-3 text-sm text-slate-400">Detailed occupancy and pricing breakdown</p>
                    <div className="mb-4 grid gap-2 md:grid-cols-3">
                      <div className="rounded border border-slate-800 p-3">
                        <p className="text-xs text-slate-400">Rooms Booked</p>
                        <p className="text-lg font-semibold">
                          {calendar.days[String(selectedDay)].booked}/{calendar.days[String(selectedDay)].total}
                        </p>
                      </div>
                      <div className="rounded border border-slate-800 p-3">
                        <p className="text-xs text-slate-400">Occupancy</p>
                        <p className="text-lg font-semibold">
                          {calendar.days[String(selectedDay)].occupancy_pct}%
                        </p>
                      </div>
                      <div className="rounded border border-slate-800 p-3">
                        <p className="text-xs text-slate-400">Projected Revenue</p>
                        <p className="text-lg font-semibold">
                          ${calendar.days[String(selectedDay)].revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </p>
                      </div>
                    </div>
                    <div className="grid gap-2 md:grid-cols-3">
                      {calendar.days[String(selectedDay)].room_types.map((rt) => (
                        <div key={rt.name} className="rounded border border-slate-800 p-3">
                          <p className="font-medium">{rt.name}</p>
                          <p className="text-sm text-slate-300">Occ: {rt.occupancy_pct}%</p>
                          <p className="text-sm text-slate-300">Booked: {rt.booked}/{rt.total_rooms}</p>
                          <p className="text-sm text-slate-300">Rate: ${rt.rate.toFixed(2)}</p>
                          <p className="text-sm text-slate-300">Revenue: ${rt.revenue.toFixed(2)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {tab === "rules" && (
          <section className="space-y-5 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">Pricing Rules</h2>
            <form onSubmit={onCreateRule} className="grid gap-3 rounded border border-slate-800 p-4 md:grid-cols-2">
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
                <p className="mb-2 text-xs text-slate-400">Apply to room types</p>
                <div className="flex flex-wrap gap-2">
                  {roomTypes.map((name) => {
                    const on = selectedRoomTypes.includes(name);
                    return (
                      <button
                        type="button"
                        key={name}
                        className={`rounded px-2 py-1 text-xs ${on ? "bg-sky-600" : "bg-slate-800"}`}
                        onClick={() =>
                          setSelectedRoomTypes((prev) =>
                            prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
                          )
                        }
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <button type="submit" className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 md:col-span-2">
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
                      <td className="py-2 pr-3">{rule.room_types.length ? rule.room_types.join(", ") : "All"}</td>
                      <td className="py-2 pr-3">
                        {rule.action.adjust_rate_percent !== undefined && `${rule.action.adjust_rate_percent}% `}
                        {rule.action.adjust_rate_dollars !== undefined && `$${rule.action.adjust_rate_dollars}`}
                      </td>
                      <td className="py-2 pr-3">{rule.enabled ? "Enabled" : "Disabled"}</td>
                      <td className="py-2 pr-3">
                        <div className="flex gap-2">
                          <button className="rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700" onClick={() => onToggleRule(rule.id)}>
                            Toggle
                          </button>
                          <button className="rounded bg-rose-700 px-2 py-1 text-xs hover:bg-rose-600" onClick={() => onDeleteRule(rule.id)}>
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
            <button className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400" onClick={runSimulation}>
              Run Simulation
            </button>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded border border-slate-800 p-3">
                <h3 className="mb-2 text-sm font-semibold">Sample Reservations</h3>
                <ul className="space-y-2 text-sm text-slate-300">
                  {SAMPLE_RESERVATIONS.map((r, idx) => (
                    <li key={`${r.room_type}-${idx}`}>
                      {r.room_type}: ${r.current_rate} (occ {r.occupancy_percentage}% / window {r.booking_window}d / pickup {r.pickup_rate})
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded border border-slate-800 p-3">
                <h3 className="mb-2 text-sm font-semibold">Simulation Results</h3>
                {!simResults.length && <p className="text-sm text-slate-300">Run simulation to view results.</p>}
                <ul className="space-y-2 text-sm text-slate-300">
                  {simResults.map((row, idx) => {
                    const delta = row.new_rate - row.original_rate;
                    const cls = delta > 0 ? "text-rose-300" : delta < 0 ? "text-emerald-300" : "text-slate-300";
                    return (
                      <li key={`${row.room_type}-${idx}`}>
                        {row.room_type}: ${row.original_rate.toFixed(2)} - {">"}{" "}
                        <span className="font-semibold">${row.new_rate.toFixed(2)}</span>{" "}
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
                className="rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
                onClick={() => setChangesOnly((v) => !v)}
              >
                {changesOnly ? "Show All Cycles" : "Show Changes Only"}
              </button>
            </div>
            <div className="space-y-2">
              {visibleCycles.map((cycle) => (
                <div key={cycle.cycle} className="rounded border border-slate-800 p-3">
                  <p className="text-xs text-slate-400">
                    Cycle #{cycle.cycle} - {cycle.timestamp}
                  </p>
                  {cycle.has_changes ? (
                    <ul className="mt-2 space-y-1 text-sm text-slate-200">
                      {cycle.changes.map((ch, idx) => (
                        <li key={`${cycle.cycle}-${idx}`}>
                          {ch.room_type}: ${ch.original_rate.toFixed(2)} - {">"} ${ch.new_rate.toFixed(2)} (
                          {ch.change_pct >= 0 ? "+" : ""}
                          {ch.change_pct}%)
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-slate-300">No actionable conditions detected.</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === "pms" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">Mews PMS</h2>
            <p className="text-sm text-slate-300">
              Mirrors the Python tools: <code className="text-slate-200">configuration/get</code> for a connection
              check, and windowed <code className="text-slate-200">reservations/getAll</code> fetches (96-hour chunks)
              with ETL into <code className="text-slate-200">room_types</code> and{" "}
              <code className="text-slate-200">reservations</code>. Credentials resolve from{" "}
              <code className="text-slate-200">pms_connections</code> (JSON in{" "}
              <code className="text-slate-200">credentials_encrypted</code>), optional overrides below, or server env{" "}
              <code className="text-slate-200">MEWS_CLIENT_TOKEN</code> / <code className="text-slate-200">MEWS_ACCESS_TOKEN</code>.
              A Supabase Edge Function on a cron schedule can call the same routes later.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pmsBusy}
                className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50"
                onClick={() => void callPmsApi("/api/pms/mews/test")}
              >
                Test connection
              </button>
              <button
                type="button"
                disabled={pmsBusy}
                className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                onClick={() => void callPmsApi("/api/pms/mews/sync")}
              >
                Sync reservations to DB
              </button>
              <button
                type="button"
                className="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
                onClick={() => setPmsLog([])}
              >
                Clear log
              </button>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">
                Advanced: credential override JSON (optional) —{" "}
                <code className="text-slate-300">{"{ \"clientToken\", \"accessToken\", \"enterpriseId?\", \"baseUrl?\" }"}</code>
              </label>
              <textarea
                value={pmsOverrideJson}
                onChange={(e) => setPmsOverrideJson(e.target.value)}
                placeholder='e.g. {"clientToken":"...","accessToken":"..."}'
                rows={4}
                className="w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-200"
              />
            </div>
            <div className="max-h-64 overflow-y-auto rounded border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-300">
              {pmsLog.length === 0 ? <p className="text-slate-500">Activity will appear here.</p> : null}
              {pmsLog.map((line, i) => (
                <p key={`${i}-${line.slice(0, 24)}`} className="whitespace-pre-wrap break-all">
                  {line}
                </p>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
