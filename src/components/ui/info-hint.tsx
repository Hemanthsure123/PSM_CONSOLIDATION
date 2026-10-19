"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

export interface InfoHintProps {
  /** The explanation — shown on hover, keyboard focus or tap. */
  children: React.ReactNode;
  /** Accessible name of the trigger. */
  label?: string;
  /** Which side of the icon the bubble opens towards. */
  align?: "start" | "center" | "end";
  className?: string;
}

/**
 * Explanations on demand. Screens show what is needed; the "why / how it works" text lives
 * behind this small (i), so it is one hover away but never in the way (progressive disclosure).
 */
export function InfoHint({ children, label = "More information", align = "center", className }: InfoHintProps) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const wrap = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <span
      ref={wrap}
      className={cn("relative inline-flex align-middle", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "absolute top-full z-50 mt-1.5 w-[min(320px,80vw)] animate-pop-in rounded-lg border bg-popover px-3 py-2.5 text-left text-[13px] font-normal leading-relaxed text-popover-foreground shadow-overlay",
            align === "start" && "left-0",
            align === "center" && "left-1/2 -translate-x-1/2",
            align === "end" && "right-0",
          )}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
