import * as React from "react";
import { cn } from "@/lib/utils";

export interface ActionBarProps {
  /** Left side: status, progress, what will happen. */
  status?: React.ReactNode;
  /** Right side: secondary actions first, the primary action last (rightmost). */
  children: React.ReactNode;
  /** Stick to the bottom of the viewport while the form scrolls. */
  sticky?: boolean;
  className?: string;
}

/**
 * Where a configure screen ends: the run button always in the same place, bottom-right, large
 * (Fitts's law), with the run's status beside it.
 */
export function ActionBar({ status, children, sticky = true, className }: ActionBarProps) {
  return (
    <div
      className={cn(
        "z-20 flex flex-col gap-3 rounded-xl border bg-card/95 px-4 py-3 shadow-raised backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:flex-row sm:items-center sm:justify-between",
        sticky && "sticky bottom-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1 text-[13px] text-muted-foreground">{status}</div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}
