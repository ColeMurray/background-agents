"use client";

import { useState } from "react";
import Link from "next/link";
import { useAutomations } from "@/hooks/use-automations";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useMeTeams } from "@/hooks/use-teams";
import { AutomationsList } from "@/components/automations/automations-list";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

export function TeamAutomations({ teamId }: { teamId: string }) {
  const { automations, loading, loadingMore, error, hasMore, loadMore, mutate } = useAutomations(
    "",
    teamId
  );
  const { hasPermission } = useCurrentUserAuthorization();
  const membership = useMeTeams();
  const canCreate =
    hasPermission("automations.create") &&
    !membership.loading &&
    !membership.error &&
    membership.teams.some((team) => team.id === teamId);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(id: string, action: "pause" | "resume" | "trigger" | "delete") {
    setActionError(null);
    const path: BrowserApiPath =
      action === "delete" ? `/api/automations/${id}` : `/api/automations/${id}/${action}`;
    try {
      const response = await browserApiFetch(path, {
        method: action === "delete" ? "DELETE" : "POST",
      });
      if (!response.ok) throw new Error(`Failed to ${action} automation`);
      await mutate();
    } catch {
      setActionError(`Failed to ${action} automation`);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-foreground">Automations</h2>
        {canCreate && (
          <Button size="xs" asChild>
            <Link href={`/automations/new?teamId=${encodeURIComponent(teamId)}`}>
              Create Automation
            </Link>
          </Button>
        )}
      </div>
      {actionError && (
        <ErrorBanner className="mb-4" role="alert">
          {actionError}
        </ErrorBanner>
      )}
      {error && (
        <ErrorBanner className="mb-4" role="alert">
          Unable to load automations.
        </ErrorBanner>
      )}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading automations...
        </p>
      ) : automations.length > 0 || !error ? (
        <AutomationsList
          automations={automations}
          teamId={teamId}
          canCreate={canCreate}
          emptyState={{ kind: "no-automations" }}
          onPause={(id) => void act(id, "pause")}
          onResume={(id) => void act(id, "resume")}
          onTrigger={(id) => void act(id, "trigger")}
          onDelete={(id) => void act(id, "delete")}
        />
      ) : null}
      {(hasMore || loadingMore) && !loading && (
        <div className="flex justify-center pt-4">
          <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading more..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
