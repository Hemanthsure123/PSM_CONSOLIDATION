"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { InfoHint } from "@/components/ui/info-hint";

export interface SettingRowProps {
  /** Id for the switch (and the label's htmlFor). Keep existing ids — tests use them. */
  id: string;
  title: React.ReactNode;
  /** One short line. Put the full explanation in `info`. */
  description?: React.ReactNode;
  /** Longer explanation behind an (i). */
  info?: React.ReactNode;
  icon?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Extra controls revealed only while the setting is on (progressive disclosure). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * A yes/no option: what it does on the left, the switch on the right. Rows stack inside a
 * Panel with dividers; dependent controls appear under a row only when it is switched on.
 */
export function SettingRow({ id, title, description, info, icon, checked, onCheckedChange, disabled, children, className }: SettingRowProps) {
  return (
    <div className={cn("py-3 first:pt-0 last:pb-0", disabled && "opacity-60", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          {icon ? <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <label htmlFor={id} className="cursor-pointer text-sm font-medium leading-5">
                {title}
              </label>
              {info ? <InfoHint align="start">{info}</InfoHint> : null}
            </div>
            {description ? <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
      </div>
      {children && checked ? <div className="mt-3 animate-fade-in pl-0 sm:pl-[26px]">{children}</div> : null}
    </div>
  );
}

/** A vertical list of SettingRows separated by hairlines. */
export function SettingList({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("divide-y", className)}>{children}</div>;
}
