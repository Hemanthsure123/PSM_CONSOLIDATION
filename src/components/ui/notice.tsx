import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const TONE: Record<NoticeTone, { box: string; icon: React.ComponentType<{ className?: string }> }> = {
  info: { box: "border-[hsl(222_70%_88%)] bg-accent text-[hsl(223_60%_28%)]", icon: Info },
  success: { box: "border-[hsl(152_40%_82%)] bg-success-soft text-[hsl(158_70%_20%)]", icon: CheckCircle2 },
  warning: { box: "border-[hsl(38_80%_82%)] bg-warning-soft text-[hsl(32_90%_24%)]", icon: AlertTriangle },
  danger: { box: "border-[hsl(5_70%_86%)] bg-destructive-soft text-[hsl(4_65%_36%)]", icon: XCircle },
};

export interface NoticeProps {
  tone?: NoticeTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** A button or link that resolves the situation. */
  action?: React.ReactNode;
  className?: string;
}

/** An inline message about the state of this screen: what happened and what to do next. */
export function Notice({ tone = "info", title, children, action, className }: NoticeProps) {
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn("flex items-start gap-3 rounded-lg border px-3.5 py-3 text-[13px] leading-relaxed", t.box, className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
