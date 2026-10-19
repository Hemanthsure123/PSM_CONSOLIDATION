import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Step {
  title: string;
  description?: string;
}

export interface StepperProps {
  steps: Step[];
  /** Zero-based index of the current step. */
  current: number;
}

/**
 * Progress through a real sequence (a wizard). Done steps are checked, the current one is
 * filled, the rest are quiet — the remaining distance is always visible (goal-gradient).
 */
export function Stepper({ steps, current }: StepperProps) {
  return (
    <nav aria-label="Progress" className="w-full">
      <ol className="flex w-full items-center gap-2">
        {steps.map((step, i) => {
          const done = i < current;
          const active = i === current;
          const last = i === steps.length - 1;
          return (
            <li key={step.title} className={cn("flex min-w-0 items-center gap-2", !last && "flex-1")} aria-current={active ? "step" : undefined}>
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular transition-colors",
                  done && "bg-primary text-primary-foreground",
                  active && "bg-primary text-primary-foreground ring-4 ring-primary/15",
                  !done && !active && "border border-input bg-card text-muted-foreground",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className={cn("block truncate text-[13px] font-medium", active || done ? "text-foreground" : "text-muted-foreground")}>
                  {step.title}
                </span>
                {step.description ? <span className="block truncate text-xs text-muted-foreground">{step.description}</span> : null}
              </span>
              {!last ? <span className={cn("mx-1 h-px min-w-4 flex-1", done ? "bg-primary" : "bg-border")} aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
