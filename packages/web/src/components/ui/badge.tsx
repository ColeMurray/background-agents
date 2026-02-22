import type { ReactNode } from "react";

type BadgeVariant = "default" | "pr-merged" | "pr-closed" | "pr-draft" | "pr-open" | "info" | "kbd";

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-muted text-muted-foreground",
  "pr-merged": "bg-success-muted text-success",
  "pr-closed": "bg-destructive-muted text-destructive",
  "pr-draft": "bg-muted text-muted-foreground",
  "pr-open": "bg-accent-muted text-accent",
  info: "bg-info-muted text-info border border-info/30",
  kbd: "font-mono text-muted-foreground border border-border bg-input rounded",
};

export function prBadgeVariant(state: string): BadgeVariant {
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

interface BadgeProps {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
}

export function Badge({ variant = "default", className = "", children }: BadgeProps) {
  return (
    <span
      className={`px-1.5 py-0.5 text-xs font-medium ${variantClasses[variant]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
