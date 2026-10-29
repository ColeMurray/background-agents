"use client";

import type { ReactNode } from "react";
import { useAutomations } from "@/hooks/use-automations";
import { useAutomationActions } from "@/hooks/use-automation-actions";
import { useCanCreateAutomation } from "@/hooks/use-can-create-automation";
import { AutomationsList } from "./automations-list";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";

const SKELETON_ROW_COUNT = 3;

/** Placeholder rows sized to match `AutomationsList` rows so the list doesn't shift on load. */
function AutomationsListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading automations"
      className="animate-pulse motion-reduce:animate-none border border-border-muted rounded-md bg-card divide-y divide-border-muted"
    >
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <div key={index} className="px-4 py-4">
          {/* Header: Name + badge | Actions */}
          <div className="flex h-8 items-start justify-between gap-3 sm:h-6 sm:items-center sm:gap-4">
            <div className="flex h-6 min-w-0 items-center gap-2">
              <div className="h-4 w-40 bg-muted rounded" />
              <div className="h-5 w-14 bg-muted rounded" />
            </div>
            <div className="hidden items-center gap-1 sm:flex">
              <div className="h-6 w-12 bg-muted rounded" />
              <div className="h-6 w-16 bg-muted rounded" />
              <div className="h-6 w-14 bg-muted rounded" />
            </div>
            <div className="h-8 w-8 bg-muted rounded sm:hidden" />
          </div>

          {/* Metadata */}
          <div className="mt-2 flex h-4 items-center gap-4">
            <div className="h-3 w-32 bg-muted rounded" />
            <div className="h-3 w-40 bg-muted rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AutomationCollection({
  teamId,
  nameSearch = "",
  children,
}: {
  teamId?: string;
  nameSearch?: string;
  children: (canCreate: boolean) => ReactNode;
}) {
  const { automations, loading, loadingMore, error, hasMore, loadMore, mutate } = useAutomations(
    nameSearch,
    teamId
  );
  const { canCreate } = useCanCreateAutomation(teamId);
  const { act, actionError } = useAutomationActions();

  return (
    <>
      {children(canCreate)}
      {actionError && (
        <ErrorBanner className="mb-4" role="alert">
          {actionError}
        </ErrorBanner>
      )}
      {error && (
        <ErrorBanner className="mb-4" role="alert">
          <div className="flex items-center justify-between gap-4">
            <span>Failed to load automations.</span>
            <Button variant="outline" size="xs" onClick={() => void mutate()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
      {loading ? (
        <AutomationsListSkeleton />
      ) : automations.length > 0 || !error ? (
        <AutomationsList
          automations={automations}
          teamId={teamId}
          canCreate={canCreate}
          emptyState={
            nameSearch ? { kind: "no-search-results", nameSearch } : { kind: "no-automations" }
          }
          onPause={(id) => void act(id, "pause")}
          onResume={(id) => void act(id, "resume")}
          onTrigger={(id) => void act(id, "trigger")}
          onDelete={(id) => void act(id, "delete")}
        />
      ) : null}
      {(hasMore || loadingMore) && !loading && (
        <div className="flex justify-center pt-4">
          <Button
            variant="outline"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            aria-label="Load more automations"
          >
            {loadingMore ? "Loading more..." : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}
