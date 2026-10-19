import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Small status labels. Soft fills, never solid colour blocks, so a table full of them stays
 * readable. `highlight` is reserved for "shortlisted / selected".
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium leading-5 [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-foreground",
        secondary: "bg-secondary text-muted-foreground",
        destructive: "bg-destructive-soft text-destructive",
        outline: "border border-border bg-card text-foreground",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        highlight: "bg-highlight text-highlight-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
