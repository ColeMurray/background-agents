import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "bg-muted text-muted-foreground",
      "pr-merged": "bg-success-muted text-success",
      "pr-closed": "bg-destructive-muted text-destructive",
      "pr-draft": "bg-muted text-muted-foreground",
      "pr-open": "bg-accent-muted text-accent",
      info: "bg-info-muted text-info border border-info/20",
      kbd: "font-mono text-muted-foreground border border-border bg-input rounded",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export function prBadgeVariant(
  state: string
): NonNullable<VariantProps<typeof badgeVariants>["variant"]> {
  switch (state) {
    case "merged":
      return "pr-merged";
    case "closed":
      return "pr-closed";
    case "draft":
      return "pr-draft";
    case "open":
    default:
      return "pr-open";
  }
}

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
