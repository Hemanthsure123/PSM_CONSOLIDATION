import * as React from "react";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "primary" | "success" | "warning" | "danger" | "highlight";

const VALUE_TONE: Record<StatTone, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  highlight: "text-foreground",
};

export interface StatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /** A short qualifier under the value ("of 5,512 resumes"). */
  hint?: React.ReactNode;
  tone?: StatTone;
  icon?: React.ReactNode;
  className?: string;
}

/**
 * One headline number. Results screens open with a row of these (numbers first), so the
 * outcome of a run is readable before any table. `highlight` marks the shortlist count.
 */
export function Stat({ label, value, hint, tone = "default", icon, className }: StatProps) {
  return (
    <div className={cn("min-w-0 rounded-xl border bg-card px-4 py-3.5 shadow-surface", className)}>
      <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground [&_svg]:size-3.5">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={cn("mt-1 font-display text-[26px] font-semibold leading-8 tracking-[-0.02em] tabular", VALUE_TONE[tone])}>
        {tone === "highlight" ? <span className="rounded-[4px] bg-highlight px-1 box-decoration-clone">{value}</span> : value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** A responsive row of Stats (2 columns on phones, up to `cols` on wide screens). */
export function StatGrid({ cols = 4, className, children }: { cols?: 2 | 3 | 4 | 5 | 6; className?: string; children: React.ReactNode }) {
  const lg = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5", 6: "lg:grid-cols-6" }[cols];
  return <div className={cn("grid grid-cols-2 gap-3", lg, className)}>{children}</div>;
}
