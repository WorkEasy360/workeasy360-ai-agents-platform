"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

interface Series {
  label: string;
  className: string; // bar fill (Tailwind bg-*)
  values: number[];
}

const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Daily bar chart from plain divs. Multiple series stack within a day.
 * Hovering (or focusing) a day shows its values; a table view is available for screen readers and exact numbers.
 */
export function DailyBars({ days, series, format }: { days: string[]; series: Series[]; format: (n: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  const totals = days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(...totals, 0);
  const shown = active ?? null;

  return (
    <div>
      <div className="mb-2 flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs">
        {series.length > 1 ? (
          <div className="flex flex-wrap gap-3">
            {series.map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1.5 text-[var(--muted)]">
                <span className={cn("size-2.5 rounded-sm", s.className)} aria-hidden /> {s.label}
              </span>
            ))}
          </div>
        ) : (
          <span />
        )}
        <span className="text-[var(--muted)] tabular-nums">
          {shown === null ? (
            <>Total {format(totals.reduce((a, b) => a + b, 0))}</>
          ) : (
            <>
              <span className="font-medium text-[var(--foreground)]">{shortDay(days[shown]!)}</span>:{" "}
              {series.length > 1 ? series.map((s) => `${s.label} ${format(s.values[shown] ?? 0)}`).join(" · ") : format(totals[shown]!)}
            </>
          )}
        </span>
      </div>

      {max === 0 ? (
        <div className="flex h-36 items-center justify-center rounded-md border border-dashed border-[var(--border)] text-sm text-[var(--muted)]">
          Nothing in the last 30 days yet.
        </div>
      ) : (
        <div className="relative h-36 border-b border-[var(--border)]" aria-hidden onMouseLeave={() => setActive(null)}>
          <div className="flex h-full items-end gap-0.5">
            {days.map((d, i) => (
              <div
                key={d}
                // Full-height hit target, bigger than the bar itself.
                className={cn("flex h-full min-w-0 flex-1 flex-col justify-end rounded-t", active === i && "bg-slate-100 dark:bg-slate-800/60")}
                onMouseEnter={() => setActive(i)}
              >
                <div className="flex flex-col-reverse gap-0.5 overflow-hidden rounded-t" style={{ height: `${(totals[i]! / max) * 100}%` }}>
                  {series.map((s) =>
                    s.values[i] ? <div key={s.label} className={s.className} style={{ flexGrow: s.values[i], minHeight: 2 }} /> : null,
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-1 flex justify-between text-[11px] text-[var(--muted)]">
        <span>{shortDay(days[0]!)}</span>
        <span>{shortDay(days[days.length - 1]!)}</span>
      </div>

      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-[var(--muted)]">Show as table</summary>
        <div className="mt-2 max-h-48 overflow-auto">
          <table className="w-full tabular-nums">
            <thead className="text-left text-[var(--muted)]">
              <tr>
                <th className="py-1 font-medium">Day</th>
                {series.map((s) => (
                  <th key={s.label} className="py-1 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days
                .map((d, i) => ({ d, i }))
                .filter(({ i }) => totals[i]! > 0)
                .reverse()
                .map(({ d, i }) => (
                  <tr key={d} className="border-t border-[var(--border)]">
                    <td className="py-1">{shortDay(d)}</td>
                    {series.map((s) => (
                      <td key={s.label} className="py-1 text-right">
                        {format(s.values[i] ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
