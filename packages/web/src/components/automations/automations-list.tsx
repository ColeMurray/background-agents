"use client";

import { useState } from "react";
import Link from "next/link";
import { describeCron } from "@open-inspect/shared";
import type { Automation } from "@open-inspect/shared";
import { AutomationStatusBadge } from "@/components/automations/automation-status-badge";
import { Button } from "@/components/ui/button";
import { FolderIcon, ClockIcon, BoltIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/time";

interface AutomationsListProps {
  automations: Automation[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onTrigger: (id: string) => void;
  onDelete: (id: string) => void;
}

export function AutomationsList({
  automations,
  onPause,
  onResume,
  onTrigger,
  onDelete,
}: AutomationsListProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  if (automations.length === 0) {
    return (
      <div className="border border-border-muted rounded-md bg-background p-8 text-center">
        <p className="text-muted-foreground">No automations yet.</p>
        <p className="text-sm text-muted-foreground mt-1">Create one to run tasks on a schedule.</p>
      </div>
    );
  }

  return (
    <div className="border border-border-muted rounded-md bg-background divide-y divide-border-muted">
      {automations.map((automation) => (
        <div key={automation.id} className="px-4 py-4">
          {/* Header: Name + badge | Actions */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href={`/automations/${automation.id}`}
                className="font-medium text-foreground hover:text-accent transition truncate"
              >
                {automation.name}
              </Link>
              <AutomationStatusBadge automation={automation} />
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {automation.enabled ? (
                <Button variant="ghost" size="xs" onClick={() => onPause(automation.id)}>
                  Pause
                </Button>
              ) : (
                <Button variant="ghost" size="xs" onClick={() => onResume(automation.id)}>
                  Resume
                </Button>
              )}
              <Button variant="ghost" size="xs" onClick={() => onTrigger(automation.id)}>
                <span className="flex items-center gap-1">
                  <BoltIcon className="w-3 h-3" aria-hidden="true" />
                  Trigger
                </span>
              </Button>
              {confirmDeleteId === automation.id ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="destructive"
                    size="xs"
                    onClick={() => {
                      onDelete(automation.id);
                      setConfirmDeleteId(null);
                    }}
                  >
                    Confirm
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setConfirmDeleteId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={() => setConfirmDeleteId(automation.id)}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>

          {/* Metadata: icon-paired items */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <FolderIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
              {automation.repoOwner}/{automation.repoName}
            </span>
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
              {automation.scheduleCron
                ? describeCron(automation.scheduleCron, automation.scheduleTz)
                : "No schedule"}
            </span>
            {automation.nextRunAt && (
              <span className="inline-flex items-center gap-1">
                Next: {formatRelativeTime(automation.nextRunAt)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
