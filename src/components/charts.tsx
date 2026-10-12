"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";

export interface Slice {
  label: string;
  value: number;
  color: string;
}

export function StatTile({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-center gap-2" style={{ color: accent }}>
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-2 text-3xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

export function DonutChart({ data, total }: { data: Slice[]; total: number }) {
  const size = 168;
  const stroke = 30;
  const radius = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return (
      <svg width={size} height={size} role="img" aria-label="No data">
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground text-sm">
          No data
        </text>
      </svg>
    );
  }

  let offset = 0;
  return (
    <svg width={size} height={size} role="img" aria-label="Source split donut chart">
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#eef2f7" strokeWidth={stroke} />
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        {data.map((d) => {
          if (d.value === 0) return null;
          const dash = (d.value / total) * circumference;
          const seg = (
            <circle
              key={d.label}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={d.color}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
            />
          );
          offset += dash;
          return seg;
        })}
      </g>
      <text x={cx} y={cy - 6} textAnchor="middle" className="fill-foreground text-2xl font-bold">
        {total}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" className="fill-muted-foreground text-[10px] uppercase tracking-wider">
        Total
      </text>
    </svg>
  );
}

export function Legend({ data, total }: { data: Slice[]; total: number }) {
  return (
    <div className="flex-1 space-y-2">
      {data.map((d) => {
        const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
        return (
          <div key={d.label} className="flex items-center gap-3">
            <span className="h-3 w-3 rounded-sm" style={{ background: d.color }} />
            <span className="flex-1 text-sm font-medium">{d.label}</span>
            <Badge variant="secondary">{d.value}</Badge>
            <span className="w-10 text-right text-sm text-muted-foreground">{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A tapering funnel of the source split: one horizontal band per stage
 * (Edge → Academy → External), each centered and sized proportional to its
 * count, so the share flowing from every source reads at a glance.
 */
export function FunnelChart({ data }: { data: Slice[] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const max = Math.max(1, ...data.map((d) => d.value));

  if (total === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No data
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {data.map((d) => {
        const pct = Math.round((d.value / total) * 100);
        // Width relative to the largest stage; floor so tiny stages stay legible.
        const width = Math.max(12, (d.value / max) * 100);
        return (
          <div key={d.label} className="flex flex-col items-center gap-1">
            <div
              className="flex h-11 items-center justify-center rounded-md text-sm font-semibold text-white shadow-sm transition-all"
              style={{ width: `${width}%`, background: d.color }}
              title={`${d.label}: ${d.value} (${pct}%)`}
            >
              <span className="tabular-nums">{d.value}</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {d.label} · {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One stage of a stacked funnel: a total, split into colored segments. */
export interface FunnelStageData {
  label: string;
  total: number;
  segments: { label: string; value: number; color: string }[];
}

/**
 * A round-wise funnel: each stage is a centered horizontal band whose width is
 * proportional to the stage total, internally segmented by source so the split
 * reads at every round. Stages narrow as candidates drop off between rounds.
 */
export function StackedFunnelChart({ stages }: { stages: FunnelStageData[] }) {
  const max = Math.max(1, ...stages.map((s) => s.total));
  const first = stages[0]?.total ?? 0;

  if (stages.every((s) => s.total === 0)) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No data
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {stages.map((stage, i) => {
        const width = Math.max(10, (stage.total / max) * 100);
        // Conversion vs. the first (top) stage — the funnel's overall retention.
        const pct = first > 0 ? Math.round((stage.total / first) * 100) : 0;
        return (
          <div key={`${stage.label}-${i}`} className="flex items-center gap-3">
            <div className="w-32 shrink-0 text-right text-xs font-medium text-muted-foreground">
              <span className="block truncate" title={stage.label}>
                {stage.label}
              </span>
            </div>
            <div className="flex-1">
              <div className="mx-auto flex h-9 overflow-hidden rounded-md" style={{ width: `${width}%` }}>
                {stage.segments.map((seg) =>
                  seg.value === 0 ? null : (
                    <div
                      key={seg.label}
                      className="flex items-center justify-center text-[11px] font-semibold text-white"
                      style={{ width: `${(seg.value / stage.total) * 100}%`, background: seg.color }}
                      title={`${seg.label}: ${seg.value}`}
                    >
                      {(seg.value / stage.total) * 100 >= 12 ? seg.value : ""}
                    </div>
                  ),
                )}
              </div>
            </div>
            <div className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground">
              <span className="font-semibold text-foreground">{stage.total}</span> · {pct}%
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BarChart({ data }: { data: Slice[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="space-y-4">
      {data.map((d) => (
        <div key={d.label} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{d.label}</span>
            <span className="tabular-nums text-muted-foreground">{d.value}</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${(d.value / max) * 100}%`, background: d.color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
