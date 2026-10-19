"use client";

import * as React from "react";

export interface Slice {
  label: string;
  value: number;
  color: string;
}

/**
 * Categorical series colours — assign in this fixed order to entities (slot 1 to the first
 * category, always the same category), never cycled or re-assigned by rank. Validated for
 * colour-vision deficiency on a light surface (adjacent ΔE ≥ 9); slots 3–4 sit below 3:1
 * contrast, so charts that use them keep visible labels / a legend with values.
 */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;
/** "Other / unknown" — a neutral that never competes with a real category. */
export const SERIES_NEUTRAL = "#a3acb9";

/** Ink that stays readable on a given fill (labels inside bars). */
function inkOn(hex: string): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "#ffffff";
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.35 ? "#152238" : "#ffffff";
}

/**
 * A single headline number. Kept for existing callers; new code uses `Stat` from
 * `@/components/ui/stat`. The accent colours the icon only — text stays in ink.
 */
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
    <div className="min-w-0 rounded-xl border bg-card px-4 py-3.5 shadow-surface">
      <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground [&_svg]:size-3.5">
        <span style={{ color: accent }} className="flex">
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 font-display text-[26px] font-semibold leading-8 tracking-[-0.02em] tabular-nums">{value}</div>
    </div>
  );
}

/** Part-to-whole for a few categories. Always shown with a `Legend` (labels + values). */
export function DonutChart({ data, total }: { data: Slice[]; total: number }) {
  const size = 156;
  const stroke = 22;
  const radius = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;
  const [hover, setHover] = React.useState<string | null>(null);

  if (total === 0) {
    return (
      <svg width={size} height={size} role="img" aria-label="No data">
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="hsl(var(--secondary))" strokeWidth={stroke} />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground text-[13px]">
          No data
        </text>
      </svg>
    );
  }

  const shown = data.filter((d) => d.value > 0);
  // A 2px surface gap between segments (only when there is more than one).
  const gap = shown.length > 1 ? 2 : 0;
  const active = shown.find((d) => d.label === hover);
  let offset = 0;
  return (
    <svg width={size} height={size} role="img" aria-label={`Split of ${total}: ${shown.map((d) => `${d.label} ${d.value}`).join(", ")}`}>
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke="hsl(var(--secondary))" strokeWidth={stroke} />
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        {shown.map((d) => {
          const dash = (d.value / total) * circumference;
          const seg = (
            <circle
              key={d.label}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={d.color}
              strokeWidth={hover === d.label ? stroke + 4 : stroke}
              strokeDasharray={`${Math.max(0, dash - gap)} ${circumference - Math.max(0, dash - gap)}`}
              strokeDashoffset={-offset}
              className="cursor-default transition-[stroke-width] duration-150"
              onMouseEnter={() => setHover(d.label)}
              onMouseLeave={() => setHover(null)}
            >
              <title>{`${d.label}: ${d.value} (${Math.round((d.value / total) * 100)}%)`}</title>
            </circle>
          );
          offset += dash;
          return seg;
        })}
      </g>
      <text x={cx} y={cy - 5} textAnchor="middle" className="fill-foreground font-display text-[24px] font-semibold tabular-nums">
        {active ? active.value : total}
      </text>
      <text x={cx} y={cy + 15} textAnchor="middle" className="fill-muted-foreground text-[11px]">
        {active ? active.label : "Total"}
      </text>
    </svg>
  );
}

export function Legend({ data, total }: { data: Slice[]; total: number }) {
  return (
    <ul className="flex-1 space-y-1.5">
      {data.map((d) => {
        const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
        return (
          <li key={d.label} className="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-[13px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: d.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
            <span className="font-medium tabular-nums">{d.value}</span>
            <span className="w-10 text-right tabular-nums text-muted-foreground">{pct}%</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A tapering funnel of a split: one horizontal band per stage, each centred and sized
 * proportional to its count, so the share from every source reads at a glance.
 */
export function FunnelChart({ data }: { data: Slice[] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const max = Math.max(1, ...data.map((d) => d.value));

  if (total === 0) {
    return <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">No data</div>;
  }

  return (
    <div className="space-y-2.5">
      {data.map((d) => {
        const pct = Math.round((d.value / total) * 100);
        // Width relative to the largest stage; floor so tiny stages stay legible.
        const width = Math.max(12, (d.value / max) * 100);
        return (
          <div key={d.label} className="flex flex-col items-center gap-1">
            <div
              className="flex h-9 items-center justify-center rounded-md text-[13px] font-semibold transition-[width] duration-300"
              style={{ width: `${width}%`, background: d.color, color: inkOn(d.color) }}
              title={`${d.label}: ${d.value} (${pct}%)`}
            >
              <span className="tabular-nums">{d.value}</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {d.label} <span className="tabular-nums">{pct}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One stage of a stacked funnel: a total, split into coloured segments. */
export interface FunnelStageData {
  label: string;
  total: number;
  segments: { label: string; value: number; color: string }[];
}

/**
 * A round-wise funnel: each stage is a centred band whose width is proportional to the stage
 * total, split by source so the mix reads at every round. Stages narrow as candidates drop off.
 */
export function StackedFunnelChart({ stages }: { stages: FunnelStageData[] }) {
  const max = Math.max(1, ...stages.map((s) => s.total));
  const first = stages[0]?.total ?? 0;

  if (stages.every((s) => s.total === 0)) {
    return <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">No data</div>;
  }

  return (
    <div className="space-y-2">
      {stages.map((stage, i) => {
        const width = Math.max(10, (stage.total / max) * 100);
        // Conversion vs. the first (top) stage — the funnel's overall retention.
        const pct = first > 0 ? Math.round((stage.total / first) * 100) : 0;
        return (
          <div key={`${stage.label}-${i}`} className="flex items-center gap-3">
            <div className="w-36 shrink-0 text-right text-[13px] text-muted-foreground">
              <span className="block truncate" title={stage.label}>
                {stage.label}
              </span>
            </div>
            <div className="flex-1">
              <div className="mx-auto flex h-8 gap-[2px] overflow-hidden rounded-md" style={{ width: `${width}%` }}>
                {stage.segments.map((seg) =>
                  seg.value === 0 ? null : (
                    <div
                      key={seg.label}
                      className="flex items-center justify-center text-[11px] font-semibold first:rounded-l-md last:rounded-r-md"
                      style={{ width: `${(seg.value / stage.total) * 100}%`, background: seg.color, color: inkOn(seg.color) }}
                      title={`${seg.label}: ${seg.value}`}
                    >
                      {(seg.value / stage.total) * 100 >= 12 ? <span className="tabular-nums">{seg.value}</span> : ""}
                    </div>
                  ),
                )}
              </div>
            </div>
            <div className="w-24 shrink-0 text-[13px] tabular-nums text-muted-foreground">
              <span className="font-semibold text-foreground">{stage.total}</span> <span className="text-xs">({pct}%)</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Magnitudes by category: thin horizontal bars, value at the end. */
export function BarChart({ data }: { data: Slice[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.label} className="space-y-1" title={`${d.label}: ${d.value}`}>
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate">{d.label}</span>
            <span className="font-medium tabular-nums">{d.value}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${(d.value / max) * 100}%`, background: d.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}
