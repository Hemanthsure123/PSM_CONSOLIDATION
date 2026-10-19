"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DisclosureProps {
  title: React.ReactNode;
  /** Shown next to the title while closed, e.g. "3 on" or "Defaults". */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * A collapsible group for options most runs never touch ("Advanced options"). Closed by
 * default so the common path stays short (Hick's law); the summary says what's inside.
 */
export function Disclosure({ title, summary, defaultOpen = false, className, children }: DisclosureProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const id = React.useId();
  return (
    <div className={cn("rounded-xl border bg-card shadow-surface", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-5 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
      >
        <span className="font-display text-[15px] font-semibold tracking-[-0.01em]">{title}</span>
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
          {!open && summary ? <span className="hidden sm:inline">{summary}</span> : null}
          <ChevronDown className={cn("h-4 w-4 transition-transform duration-150", open && "rotate-180")} />
        </span>
      </button>
      {/* Always mounted (hidden while closed): controls keep their state and ids, and stay findable. */}
      <div id={id} hidden={!open} className="animate-fade-in border-t px-5 py-4">
        {children}
      </div>
    </div>
  );
}
