import { businessByMonth, businessTotals, loadBusinessNumbers, type BusinessTotals } from "@/lib/admin/business-numbers";
import { BUSINESS_WINDOWS, type BusinessWindow } from "@/lib/admin/business-window";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";

/**
 * A property's occupancy, ADR and revenue for one window, on its Command
 * Center page: the window's totals and a line per month. Totals only, the
 * way the property's calendar adds a night up; nothing about a booking or a
 * guest. Read under the viewer's own session (staff_hotel_business_numbers),
 * so the database decides: a platform admin for any property, sales for real
 * ones only. Only rendered for a role that may read business numbers.
 */

function money(amount: number, currency: string, digits: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function Figures({ totals, currency }: { totals: BusinessTotals; currency: string }) {
  const tiles = [
    { label: "Occupancy", value: totals.occupancyPct == null ? "n/a" : `${totals.occupancyPct}%` },
    { label: "ADR", value: totals.adr == null ? "n/a" : money(totals.adr, currency, 2) },
    { label: "Room revenue", value: money(totals.roomRevenue, currency, 0) },
    { label: "Rooms sold", value: totals.roomsSold.toLocaleString("en-US") },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">{t.label}</div>
          <div className="mt-1 text-xl font-semibold text-slate-100">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

export function BusinessNumbersFrame({
  hotelId,
  range,
  children,
}: {
  hotelId: string;
  range: BusinessWindow;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900" aria-label="Business numbers">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Business numbers</h2>
        <nav className="flex flex-wrap gap-1 text-xs" aria-label="Window">
          {BUSINESS_WINDOWS.map((w) => (
            <Link
              key={w.key}
              href={`/admin/hotels/${hotelId}?nights=${w.key}`}
              className={`rounded px-2 py-1 ${
                w.key === range.key ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              }`}
            >
              {w.label}
            </Link>
          ))}
        </nav>
      </header>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

export async function HotelBusinessNumbers({
  hotelId,
  currency,
  range,
}: {
  hotelId: string;
  currency: string;
  range: BusinessWindow;
}) {
  let nights;
  try {
    nights = await loadBusinessNumbers(createClient(await cookies()), hotelId, range.from, range.to);
  } catch (e) {
    return (
      <p className="text-sm text-amber-200">
        Could not read the numbers: {e instanceof Error ? e.message : String(e)}
      </p>
    );
  }
  const months = businessByMonth(nights);
  return (
    <>
      <p className="text-xs text-slate-500">
        {range.from} to {range.to}, in {currency}. Sellable occupancy; ADR over rooms sold.
      </p>
      <Figures totals={businessTotals(nights)} currency={currency} />
      {months.length > 1 ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-4">Month</th>
              <th className="py-2 pr-4">Occupancy</th>
              <th className="py-2 pr-4">ADR</th>
              <th className="py-2 pr-4">Room revenue</th>
              <th className="py-2">Rooms sold</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {months.map(({ month, totals }) => (
              <tr key={month}>
                <td className="py-2 pr-4 text-slate-300">{monthLabel(month)}</td>
                <td className="py-2 pr-4 text-slate-300">{totals.occupancyPct == null ? "n/a" : `${totals.occupancyPct}%`}</td>
                <td className="py-2 pr-4 text-slate-300">{totals.adr == null ? "n/a" : money(totals.adr, currency, 2)}</td>
                <td className="py-2 pr-4 text-slate-300">{money(totals.roomRevenue, currency, 0)}</td>
                <td className="py-2 text-slate-300">{totals.roomsSold.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
