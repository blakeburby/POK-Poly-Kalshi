import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.08em] whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "border-line-strong bg-surface-2 text-fg-secondary",
        up: "border-up/30 bg-up/10 text-up",
        down: "border-down/30 bg-down/10 text-down",
        amber: "border-amber/30 bg-amber/10 text-amber",
        cyan: "border-cyan/30 bg-cyan/10 text-cyan",
        violet: "border-violet/30 bg-violet/10 text-violet",
        kalshi: "border-kalshi/30 bg-kalshi/10 text-kalshi",
        poly: "border-poly/30 bg-poly/10 text-poly",
        ghost: "border-transparent bg-transparent text-fg-muted px-0",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
