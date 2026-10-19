import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { InfoHint } from "@/components/ui/info-hint";

export interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  /** A short line under the control (format, example). */
  hint?: React.ReactNode;
  /** Longer explanation behind an (i). */
  info?: React.ReactNode;
  /** Shown instead of the hint, in red, when the value is invalid. */
  error?: React.ReactNode;
  /** Marks the field as optional (most fields are required). */
  optional?: boolean;
  /** Right side of the label row (a counter, a small action). */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/** Label above the control, hint or error below — one consistent shape for every input. */
export function Field({ label, htmlFor, hint, info, error, optional, aside, className, children }: FieldProps) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Label htmlFor={htmlFor}>{label}</Label>
          {optional ? <span className="text-xs text-muted-foreground">(optional)</span> : null}
          {info ? <InfoHint align="start">{info}</InfoHint> : null}
        </div>
        {aside ? <div className="text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
