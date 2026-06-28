"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  describeCron,
  getReasoningConfig,
  type AutomationRun,
  type AutomationRunGroup,
  type ListAutomationRunsResponse,
} from "@open-inspect/shared";
import { useSidebarContext } from "@/components/sidebar-layout";
import { useAutomation, useAutomationRuns } from "@/hooks/use-automations";
import { RunHistory } from "@/components/automations/run-history";
import { AutomationStatusBadge } from "@/components/automations/automation-status-badge";
import { ConditionSummary } from "@/components/automations/condition-summary";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SidebarIcon, BackIcon, PencilIcon } from "@/components/ui/icons";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { formatModelNameLower } from "@/lib/format";
import { formatRepoLabel } from "@/lib/repo-label";

const RUNS_PAGE_SIZE = 20;

function formatAutomationTargetLabel(automation: {
  targetMode: string;
  repoOwner: string | null;
  repoName: string | null;
  targets?: unknown[];
}): string {
  if (automation.targetMode === "fixed_multi_repo") {
    const count = automation.targets?.length ?? 0;
    return `${count} ${count === 1 ? "repository" : "repositories"}`;
  }
  return formatRepoLabel(automation.repoOwner, automation.repoName);
}

export default function AutomationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { isOpen, toggle } = useSidebarContext();
  const router = useRouter();
  const { automation, loading, mutate } = useAutomation(id);
  const {
    runs,
    groups,
    total: totalRuns,
    loading: loadingRuns,
    mutate: mutateRuns,
  } = useAutomationRuns(id, RUNS_PAGE_SIZE, 0);
  const [extraRuns, setExtraRuns] = useState<AutomationRun[]>([]);
  const [extraGroups, setExtraGroups] = useState<AutomationRunGroup[]>([]);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [effectiveTotalRuns, setEffectiveTotalRuns] = useState(totalRuns);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const visibleRuns = [...runs, ...extraRuns];
  const visibleGroups = [...groups, ...extraGroups];
  const hasGroupedRunHistory = visibleGroups.length > 0;
  const visibleRunHistoryCount = hasGroupedRunHistory ? visibleGroups.length : visibleRuns.length;
  const reasoningLabel = automation
    ? (automation.reasoningEffort ??
      (getReasoningConfig(automation.model) ? "Model default" : "Not supported"))
    : null;

  useEffect(() => {
    setExtraRuns([]);
    setExtraGroups([]);
  }, [id]);

  useEffect(() => {
    setEffectiveTotalRuns(totalRuns);
  }, [totalRuns]);

  const refreshRuns = () => {
    setExtraRuns([]);
    setExtraGroups([]);
    mutateRuns();
  };

  const handleLoadMoreRuns = async () => {
    if (!id || loadingMoreRuns) return;
    setLoadingMoreRuns(true);
    setActionError(null);

    const params = new URLSearchParams({
      limit: String(RUNS_PAGE_SIZE),
      offset: String(visibleRunHistoryCount),
    });

    try {
      const res = await fetch(`/api/automations/${id}/runs?${params.toString()}`);
      if (!res.ok) {
        setActionError("Failed to load more runs");
        return;
      }

      const data = (await res.json()) as ListAutomationRunsResponse;
      const nextRuns = data.runs ?? [];
      const nextGroups = data.groups ?? [];
      setEffectiveTotalRuns(data.total);

      setExtraRuns((prev) => {
        const seen = new Set([...runs, ...prev].map((run) => run.id));
        return [...prev, ...nextRuns.filter((run) => !seen.has(run.id))];
      });
      setExtraGroups((prev) => {
        const seen = new Set([...groups, ...prev].map((group) => group.id));
        return [...prev, ...nextGroups.filter((group) => !seen.has(group.id))];
      });
    } catch (error) {
      console.error("Failed to load more automation runs:", error);
      setActionError("Failed to load more runs");
    } finally {
      setLoadingMoreRuns(false);
    }
  };

  const handleAction = async (action: "pause" | "resume" | "trigger") => {
    setActionError(null);
    try {
      const res = await fetch(`/api/automations/${id}/${action}`, { method: "POST" });
      if (!res.ok) {
        setActionError(`Failed to ${action} automation`);
        return;
      }
      mutate();
      refreshRuns();
    } catch (error) {
      console.error(`Failed to ${action} automation:`, error);
      setActionError(`Failed to ${action} automation`);
    }
  };

  const handleDelete = async () => {
    setActionError(null);
    try {
      const res = await fetch(`/api/automations/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setActionError("Failed to delete automation");
        return;
      }
      router.push("/automations");
    } catch (error) {
      console.error("Failed to delete automation:", error);
      setActionError("Failed to delete automation");
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
      </div>
    );
  }

  if (!automation) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Automation not found.</p>
        <Link href="/automations">
          <Button variant="outline" size="sm">
            Back to Automations
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3 flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            >
              <SidebarIcon className="w-4 h-4" />
            </Button>
            <Link
              href="/automations"
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              aria-label="Back to automations"
            >
              <BackIcon className="w-4 h-4" />
            </Link>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto">
          {actionError && (
            <ErrorBanner className="mb-4" role="alert">
              {actionError}
            </ErrorBanner>
          )}

          {/* Header */}
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-semibold text-foreground">{automation.name}</h1>
                <AutomationStatusBadge automation={automation} />
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {formatAutomationTargetLabel(automation)}
                {automation.baseBranch && ` · ${automation.baseBranch}`}
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-none sm:flex-row sm:flex-wrap sm:justify-end sm:gap-2">
              <Link href={`/automations/${id}/edit`} className="w-full sm:w-auto">
                <Button variant="outline" size="sm" className="w-full sm:w-auto">
                  <span className="flex items-center gap-1.5">
                    <PencilIcon className="w-3.5 h-3.5" />
                    Edit
                  </span>
                </Button>
              </Link>
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => handleAction("trigger")}
              >
                Trigger Now
              </Button>
              {automation.enabled ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => handleAction("pause")}
                >
                  Pause
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => handleAction("resume")}
                >
                  Resume
                </Button>
              )}
              {confirmDelete ? (
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-1">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={handleDelete}
                  >
                    Confirm Delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>

          {/* Config section */}
          <div className="border border-border-muted rounded-md bg-background p-4 mb-8">
            <h2 className="text-lg font-medium text-foreground mb-3">Configuration</h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Trigger</dt>
                <dd className="text-foreground">
                  {automation.triggerType === "schedule"
                    ? automation.scheduleCron
                      ? describeCron(automation.scheduleCron, automation.scheduleTz)
                      : "Schedule (no cron)"
                    : {
                        sentry: "Sentry Alert",
                        webhook: "Inbound Webhook",
                        github_event: "GitHub Event",
                        linear_event: "Linear Event",
                        slack_event: "Slack Message",
                      }[automation.triggerType] || automation.triggerType}
                  {automation.eventType && (
                    <span className="text-muted-foreground ml-1">({automation.eventType})</span>
                  )}
                </dd>
              </div>
              {automation.triggerType === "schedule" && (
                <div>
                  <dt className="text-muted-foreground">Timezone</dt>
                  <dd className="text-foreground">{automation.scheduleTz}</dd>
                </div>
              )}
              {automation.triggerType === "webhook" && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Webhook URL</dt>
                  <dd className="text-foreground font-mono text-xs break-all">
                    POST /webhooks/automation/{automation.id}
                  </dd>
                </div>
              )}
              {automation.triggerType === "sentry" && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Sentry Webhook URL</dt>
                  <dd className="text-foreground font-mono text-xs break-all">
                    POST /webhooks/sentry/{automation.id}
                  </dd>
                </div>
              )}
              {automation.triggerConfig?.conditions &&
                automation.triggerConfig.conditions.length > 0 && (
                  <ConditionSummary conditions={automation.triggerConfig.conditions} />
                )}
              <div>
                <dt className="text-muted-foreground">Model</dt>
                <dd className="text-foreground">{formatModelNameLower(automation.model)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reasoning</dt>
                <dd className="text-foreground">{reasoningLabel}</dd>
              </div>
              {automation.triggerType === "schedule" && (
                <div>
                  <dt className="text-muted-foreground">Next Run</dt>
                  <dd className="text-foreground">
                    {automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : "—"}
                  </dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Instructions</dt>
                <dd className="text-foreground whitespace-pre-wrap mt-1">
                  {automation.instructions}
                </dd>
              </div>
            </dl>
          </div>

          {/* Run history */}
          <div>
            <h2 className="text-lg font-medium text-foreground mb-3">Run History</h2>
            <RunHistory
              runs={visibleRuns}
              groups={visibleGroups}
              total={effectiveTotalRuns}
              loading={loadingRuns || loadingMoreRuns}
              hasMore={visibleRunHistoryCount < effectiveTotalRuns}
              onLoadMore={handleLoadMoreRuns}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
