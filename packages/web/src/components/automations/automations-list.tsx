"use client";

import { useState } from "react";
import Link from "next/link";
import { describeCron } from "@open-inspect/shared/cron";
import { GITHUB_WEBHOOK_EVENT_CATALOG } from "@open-inspect/shared/triggers";
import type { Automation, AutomationListItem } from "@open-inspect/shared/types/automations";
import { AutomationStatusBadge } from "@/components/automations/automation-status-badge";
import { ExecutionActivity } from "@/components/automations/execution-activity";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FolderIcon, BoxIcon, ClockIcon, BoltIcon, MoreIcon } from "@/components/ui/icons";
import { useEnvironments } from "@/hooks/use-environments";
import { formatFutureRelativeTime } from "@/lib/time";
import { formatAutomationTargetsLabel } from "@/lib/repo-label";

interface AutomationsListProps {
  automations: AutomationListItem[];
  emptyState: { kind: "no-automations" } | { kind: "no-search-results"; nameSearch: string };
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onTrigger: (id: string) => void;
  onDelete: (id: string) => void;
}

const GITHUB_EVENT_LABELS: Record<string, string> = Object.fromEntries(
  GITHUB_WEBHOOK_EVENT_CATALOG.map(({ event, action, shortLabel }) => [
    `${event}.${action}`,
    shortLabel,
  ])
);

function describeTrigger(automation: Automation): string {
  if (automation.triggerType === "schedule" && automation.scheduleCron) {
    return describeCron(automation.scheduleCron, automation.scheduleTz);
  }

  const TRIGGER_LABELS: Record<string, string> = {
    sentry: "Sentry alert",
    webhook: "Inbound webhook",
    github_event: "GitHub event",
    linear_event: "Linear event",
  };

  const label = TRIGGER_LABELS[automation.triggerType] || automation.triggerType;

  if (automation.eventType) {
    const EVENT_LABELS: Record<string, string> = {
      "issue.created": "new error",
      "issue.regression": "error regression",
      "metric_alert.critical": "metric alert",
      "webhook.received": "webhook received",
      ...GITHUB_EVENT_LABELS,
    };
    const eventLabel = EVENT_LABELS[automation.eventType] || automation.eventType;
    return `${label}: ${eventLabel}`;
  }

  return label;
}

function describeCompactTrigger(automation: Automation): string {
  if (automation.triggerType !== "schedule" || !automation.scheduleCron) {
    return describeTrigger(automation);
  }

  return describeCron(automation.scheduleCron, automation.scheduleTz, { compact: true });
}

export function AutomationsList({
  automations,
  emptyState,
  onPause,
  onResume,
  onTrigger,
  onDelete,
}: AutomationsListProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const { environments } = useEnvironments();
  const automationToDelete = automations.find((automation) => automation.id === confirmDeleteId);

  if (automations.length === 0) {
    if (emptyState.kind === "no-search-results") {
      return (
        <div className="border border-border-muted rounded-md bg-card p-8 text-center">
          <p className="text-muted-foreground">
            No automations match &quot;{emptyState.nameSearch}&quot;.
          </p>
          <p className="text-sm text-muted-foreground mt-1">Try a different name.</p>
        </div>
      );
    }

    return (
      <div className="border border-border-muted rounded-md bg-card p-8 text-center">
        <p className="text-muted-foreground">No automations yet.</p>
        <p className="text-sm text-muted-foreground mt-1">
          Start from a template, or create one to run tasks on a schedule or in response to events.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" asChild>
            <Link href="/automations/templates">Start from a template</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/automations/new">Create Automation</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="border border-border-muted rounded-md bg-card divide-y divide-border-muted">
        {automations.map((automation) => (
          <div key={automation.id} className="px-4 py-4">
            {/* Header: Name + badge | Actions */}
            <div className="flex items-start justify-between gap-3 sm:items-center sm:gap-4">
              <div className="flex min-w-0 items-center gap-2">
                <Link
                  href={`/automations/${automation.id}`}
                  className="font-medium text-foreground hover:text-accent transition truncate"
                >
                  {automation.name}
                </Link>
                <AutomationStatusBadge automation={automation} />
                <ExecutionActivity executions={automation.recentExecutions} />
              </div>
              <div className="hidden flex-shrink-0 items-center gap-1 sm:flex">
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
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={() => setConfirmDeleteId(automation.id)}
                >
                  Delete
                </Button>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Actions for ${automation.name}`}
                    className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground sm:hidden"
                  >
                    <MoreIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="sm:hidden">
                  <DropdownMenuItem
                    onSelect={() =>
                      automation.enabled ? onPause(automation.id) : onResume(automation.id)
                    }
                  >
                    {automation.enabled ? "Pause" : "Resume"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onTrigger(automation.id)}>
                    <BoltIcon aria-hidden="true" />
                    Trigger now
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setConfirmDeleteId(automation.id)}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Metadata: icon-paired items */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                {automation.environmentIds.length > 0 && automation.repositories.length === 0 ? (
                  <BoxIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                ) : (
                  <FolderIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                )}
                {formatAutomationTargetsLabel(automation, environments)}
              </span>
              <span className="inline-flex items-center gap-1">
                <ClockIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                <span
                  className="sm:hidden"
                  title={describeTrigger(automation)}
                  aria-label={describeTrigger(automation)}
                >
                  {describeCompactTrigger(automation)}
                </span>
                <span className="hidden sm:inline">{describeTrigger(automation)}</span>
              </span>
              {automation.triggerType === "schedule" && automation.nextRunAt && (
                <span className="inline-flex items-center gap-1">
                  Next: {formatFutureRelativeTime(automation.nextRunAt)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <AlertDialog
        open={automationToDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete automation?</AlertDialogTitle>
            <AlertDialogDescription>
              {automationToDelete
                ? `This will permanently delete "${automationToDelete.name}".`
                : "This will permanently delete the automation."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (automationToDelete) onDelete(automationToDelete.id);
                setConfirmDeleteId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
