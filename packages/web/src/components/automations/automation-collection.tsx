"use client";

import type { ReactNode } from "react";
import { useAutomations } from "@/hooks/use-automations";
import { useAutomationActions } from "@/hooks/use-automation-actions";
import { useCanCreateAutomation } from "@/hooks/use-can-create-automation";
import { AutomationsList } from "./automations-list";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";

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
        <div className="flex justify-center py-12" role="status" aria-label="Loading automations">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
        </div>
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
