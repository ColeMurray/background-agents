"use client";

import Link from "next/link";
import useSWR from "swr";
import { CollapsibleSection } from "./collapsible-section";
import { Badge } from "@/components/ui/badge";
import { PullRequestStateIcon } from "@/components/pr-state-icon";
import { pullRequestSummaryDisplay } from "@/lib/pr-summary";
import { formatRelativeTime } from "@/lib/time";
import { formatRepoLabel } from "@/lib/repo-label";
import type { Session, SessionStatus } from "@open-inspect/shared/types/sessions";
import { isSessionInactive } from "@open-inspect/shared/types/session-activity";

interface ChildSessionsSectionProps {
  sessionId: string;
}

// Typed as SessionStatus rather than string so the compiler checks the arms.
// While it was `string` this switch carried a `case "running"`, which has never
// been a SessionStatus -- it is a sandbox status, and the two vocabularies
// leaking into one switch is exactly the confusion this module is being cleaned
// up to remove.
function statusBadgeVariant(status: SessionStatus) {
  switch (status) {
    case "active":
      return "info" as const;
    case "completed":
      return "pr-merged" as const;
    case "cancelled":
    case "failed":
      return "pr-closed" as const;
    case "created":
    case "archived":
      return "default" as const;
  }
}

export function ChildSessionsSection({ sessionId }: ChildSessionsSectionProps) {
  const { data } = useSWR<{ children: Session[] }>(`/api/sessions/${sessionId}/children`, {
    // Primary refresh is event-driven via WebSocket child_session_update → SWR mutate().
    // This is a safety-net fallback for missed WS messages during reconnections.
    refreshInterval: (latestData) => {
      if (!latestData?.children?.length) return 0;
      const hasActiveChild = latestData.children.some((c) => !isSessionInactive(c.status));
      return hasActiveChild ? 30_000 : 0;
    },
  });

  const children = data?.children;
  if (!children?.length) return null;

  return (
    <CollapsibleSection key={sessionId} title="Child sessions">
      <div className="space-y-2">
        {children.map((child) => {
          const prDisplay = pullRequestSummaryDisplay(child.pullRequestSummary);
          return (
            <Link
              key={child.id}
              href={`/session/${child.id}`}
              className="block p-2 hover:bg-muted transition-colors rounded"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatRelativeTime(child.updatedAt || child.createdAt)}
                  </span>
                  {prDisplay && (
                    <PullRequestStateIcon state={prDisplay.state} label={prDisplay.label} />
                  )}
                  <span className="text-sm truncate">
                    {child.title || formatRepoLabel(child.repoOwner, child.repoName)}
                  </span>
                </div>
                <Badge variant={statusBadgeVariant(child.status)} className="shrink-0">
                  {child.status}
                </Badge>
              </div>
            </Link>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}
