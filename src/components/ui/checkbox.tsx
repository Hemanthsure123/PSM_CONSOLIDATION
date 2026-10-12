"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** Lightweight, dependency-free checkbox styled to match shadcn/ui. */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "peer h-5 w-5 shrink-0 rounded border border-primary ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary text-primary-foreground" : "bg-background",
        className,
      )}
    >
      {checked ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
    </button>
  );
}
