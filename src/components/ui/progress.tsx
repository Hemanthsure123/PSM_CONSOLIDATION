import * as React from "react";
import { cn } from "@/lib/utils";

export interface ProgressProps {
  /** Done so far. Omit (or pass max 0) for an indeterminate bar. */
  value?: number;
  max?: number;
  tone?: "primary" | "success" | "warning" | "danger";
  /** Accessible label, e.g. "Screening resumes". */
  label?: string;
  className?: string;
}

const FILL = { primary: "bg-primary", success: "bg-success", warning: "bg-warning", danger: "bg-destructive" };

/** Immediate, continuous feedback while work runs (Doherty threshold). */
export function Progress({ value, max = 100, tone = "primary", label, className }: ProgressProps) {
  const indeterminate = value === undefined || !max;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={indeterminate ? undefined : max}
      aria-valuenow={indeterminate ? undefined : value}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-secondary", className)}
    >
      {indeterminate ? (
        <div className={cn("absolute inset-y-0 w-2/5 animate-progress-indeterminate rounded-full", FILL[tone])} />
      ) : (
        <div className={cn("h-full rounded-full transition-[width] duration-300 ease-out", FILL[tone])} style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}
