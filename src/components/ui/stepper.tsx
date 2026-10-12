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

/** Horizontal multi-stage stepper for the consolidation wizard. */
export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className="flex w-full items-center">
      {steps.map((step, i) => {
        const isComplete = i < current;
        const isActive = i === current;
        const isLast = i === steps.length - 1;
        return (
          <li
            key={step.title}
            className={cn("flex items-center", !isLast && "flex-1")}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors",
                  isComplete && "border-primary bg-primary text-primary-foreground",
                  isActive && "border-primary text-primary",
                  !isComplete && !isActive && "border-muted-foreground/30 text-muted-foreground",
                )}
              >
                {isComplete ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
              </div>
              <div className="hidden sm:block">
                <div
                  className={cn(
                    "text-sm font-medium",
                    isActive || isComplete ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {step.title}
                </div>
                {step.description ? (
                  <div className="text-xs text-muted-foreground">{step.description}</div>
                ) : null}
              </div>
            </div>
            {!isLast ? (
              <div
                className={cn(
                  "mx-3 h-0.5 flex-1 rounded transition-colors",
                  isComplete ? "bg-primary" : "bg-muted-foreground/20",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
