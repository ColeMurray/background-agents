"use client";

import Link from "next/link";
import useSWR from "swr";
import { CollapsibleSection } from "./collapsible-section";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/time";
import type { SessionItem } from "@/components/session-sidebar";

interface ChildSessionsSectionProps {
  sessionId: string;
}

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed", "archived"]);

function statusBadgeVariant(status: string) {
  switch (status) {
    case "active":
    case "running":
      return "info" as const;
    case "completed":
      return "pr-merged" as const;
    case "cancelled":
    case "failed":
      return "pr-closed" as const;
    default:
      return "default" as const;
  }
}

export function ChildSessionsSection({ sessionId }: ChildSessionsSectionProps) {
  const { data } = useSWR<{ children: SessionItem[] }>(`/api/sessions/${sessionId}/children`, {
    refreshInterval: (latestData) => {
      if (!latestData?.children?.length) return 0;
      const hasActiveChild = latestData.children.some((c) => !TERMINAL_STATUSES.has(c.status));
      return hasActiveChild ? 10_000 : 0;
    },
  });

  const children = data?.children;
  if (!children?.length) return null;

  return (
    <CollapsibleSection title="Sub-tasks" defaultOpen={true}>
      <div className="space-y-2">
        {children.map((child) => (
          <Link
            key={child.id}
            href={`/session/${child.id}`}
            className="block p-2 hover:bg-muted transition-colors rounded"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm truncate">
                {child.title || `${child.repoOwner}/${child.repoName}`}
              </span>
              <Badge variant={statusBadgeVariant(child.status)} className="shrink-0">
                {child.status}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {formatRelativeTime(child.updatedAt || child.createdAt)}
            </div>
          </Link>
        ))}
      </div>
    </CollapsibleSection>
  );
}
