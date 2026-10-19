import * as React from "react";
import { cn } from "@/lib/utils";

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** Section title — what this block is for, in a few words. */
  title?: React.ReactNode;
  /** One short line under the title. Longer guidance belongs in an InfoHint. */
  description?: React.ReactNode;
  /** Right-aligned header controls (secondary buttons, a count, a toggle). */
  actions?: React.ReactNode;
  /** Optional icon shown before the title. */
  icon?: React.ReactNode;
  /** Bottom strip for the block's own actions. */
  footer?: React.ReactNode;
  bodyClassName?: string;
  /** Remove body padding (tables that run edge to edge). */
  flush?: boolean;
}

/**
 * A titled section on a surface. The building block of every screen: related controls live
 * together inside one Panel (proximity / common region), unrelated ones in separate Panels.
 */
export const Panel = React.forwardRef<HTMLElement, PanelProps>(
  ({ title, description, actions, icon, footer, className, bodyClassName, flush, children, ...props }, ref) => {
    const hasHeader = title || description || actions;
    return (
      <section ref={ref} className={cn("rounded-xl border bg-card shadow-surface", className)} {...props}>
        {hasHeader ? (
          <header className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4", flush ? "pb-4" : "pb-3")}>
            <div className="flex min-w-0 items-start gap-3">
              {icon ? (
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground [&_svg]:size-4">
                  {icon}
                </span>
              ) : null}
              <div className="min-w-0">
                {title ? <h2 className="font-display text-[16px] font-semibold leading-6 tracking-[-0.01em]">{title}</h2> : null}
                {description ? <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
              </div>
            </div>
            {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
          </header>
        ) : null}
        <div className={cn(flush ? "" : hasHeader ? "px-5 pb-5" : "p-5", bodyClassName)}>{children}</div>
        {footer ? <footer className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-muted/40 px-5 py-3">{footer}</footer> : null}
      </section>
    );
  },
);
Panel.displayName = "Panel";
