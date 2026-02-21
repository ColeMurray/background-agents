import type { ReactNode } from "react";

type BadgeVariant = "default" | "pr-merged" | "pr-closed" | "pr-draft" | "pr-open" | "info" | "kbd";

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-muted text-muted-foreground",
  "pr-merged": "bg-success-muted text-success",
  "pr-closed": "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  "pr-draft": "bg-muted text-muted-foreground",
  "pr-open": "bg-accent-muted text-accent",
  info: "bg-blue-500/10 text-blue-600 border border-blue-500/20",
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
