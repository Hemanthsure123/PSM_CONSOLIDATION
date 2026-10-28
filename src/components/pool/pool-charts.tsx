"use client";

import * as React from "react";
import { SERIES, SERIES_NEUTRAL } from "@/components/charts";
import type { Product } from "@/lib/pool/types";

/**
 * Charts of the eligible pool. Colour does one job per chart:
 *  - products are categories → the app's categorical series, in a fixed slot each;
 *  - stages, verdicts and interview levels are ORDERED → one blue, dark (best) to light.
 * Every bar carries its number in text, so nothing is read from colour alone.
 */

export const PRODUCT_COLOR: Record<Product, string> = { edge2: SERIES[0], edge1: SERIES[1], academy: SERIES[2] };

/** Sequential blue, best (darkest) first. Light steps sit below 3:1 on white, so their counts are always printed. */
export const ORDINAL = ["#143a99", "#1f57e0", "#5c86ea", "#9db5f2", "#cfdcf8"] as const;
export { SERIES_NEUTRAL };

const fmt = (n: number) => n.toLocaleString("en-IN");
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

/**
 * A stage funnel: one bar per stage, its length the share of the first stage, the count and
 * the share beside it. Stages are cumulative ("reached at least this stage").
 */
export function StageFunnel({ stages, color }: { stages: { label: string; value: number; note?: string }[]; color: string }) {
  const first = stages[0]?.value ?? 0;
  return (
    <ol className="space-y-2.5" aria-label="Stage funnel">
      {stages.map((s) => {
        const share = pct(s.value, first);
        return (
          <li key={s.label} title={`${s.label}: ${fmt(s.value)} (${share}% of ${stages[0].label.toLowerCase()})`}>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate">{s.label}</span>
              <span className="shrink-0 tabular-nums">
                <span className="font-semibold">{fmt(s.value)}</span>
                <span className="ml-1.5 text-xs text-muted-foreground">{share}%</span>
              </span>
            </div>
            <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(s.value ? 1.5 : 0, share)}%`, background: color }} />
            </div>
            {s.note ? <p className="mt-1 text-xs text-muted-foreground">{s.note}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

export interface StackRow {
  label: string;
  /** Segments in legend order; zero segments are skipped. */
  parts: { label: string; value: number; color: string }[];
  /** Shown after the bar (defaults to the parts' sum). */
  total?: number;
}

/**
 * Horizontal stacked bars on one shared scale (the largest row is full width), with a 2px
 * surface gap between segments and the row total at the end. Hover a segment for its count.
 */
export function StackedBars({ rows, legend }: { rows: StackRow[]; legend: { label: string; color: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.total ?? r.parts.reduce((s, p) => s + p.value, 0)));
  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {legend.map((l) => (
          <li key={l.label} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: l.color }} aria-hidden />
            {l.label}
          </li>
        ))}
      </ul>
      <ul className="space-y-2">
        {rows.map((r) => {
          const sum = r.parts.reduce((s, p) => s + p.value, 0);
          const total = r.total ?? sum;
          const shown = r.parts.filter((p) => p.value > 0);
          return (
            <li key={r.label} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_3.25rem] items-center gap-3 text-[13px]">
              <span className="truncate" title={r.label}>
                {r.label}
              </span>
              <div className="flex h-3 gap-[2px]" style={{ width: `${(sum / max) * 100}%`, minWidth: sum ? "4px" : 0 }}>
                {shown.map((p) => (
                  <div
                    key={p.label}
                    className="h-full first:rounded-l-[4px] last:rounded-r-[4px]"
                    style={{ flexGrow: p.value, flexBasis: 0, background: p.color }}
                    title={`${r.label} · ${p.label}: ${fmt(p.value)}`}
                  />
                ))}
              </div>
              <span className="text-right font-medium tabular-nums">{fmt(total)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A labelled count with a thin bar against a total — one cell of the eligibility matrix. */
export function CountBar({ value, of, color, label }: { value: number; of: number; color: string; label: string }) {
  return (
    <div title={`${label}: ${fmt(value)} of ${fmt(of)}`}>
      <div className="font-display text-[20px] font-semibold leading-7 tabular-nums">{fmt(value)}</div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full" style={{ width: `${Math.max(value ? 2 : 0, pct(value, of))}%`, background: color }} />
      </div>
    </div>
  );
}
