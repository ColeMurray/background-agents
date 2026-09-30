"use client";

import { useState } from "react";
import { AUDIT_ACTION_OPTIONS, AuditEventCard } from "@/components/settings/audit-log-settings";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useAuditEvents } from "@/hooks/use-audit-events";

export function TeamActivity({ teamId }: { teamId: string }) {
  const [action, setAction] = useState("");
  const audit = useAuditEvents({
    endpoint: `/api/teams/${encodeURIComponent(teamId)}/activity`,
    action,
  });
  return (
    <section aria-labelledby="team-activity-heading">
      <h2 id="team-activity-heading" className="text-lg font-semibold text-foreground">
        Activity
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Team events are shown newest first.</p>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <label htmlFor="team-activity-action" className="text-sm font-medium">
          Event type
        </label>
        <select
          id="team-activity-action"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          className="max-w-full rounded border border-border bg-background px-2 py-2 text-sm"
        >
          <option value="">All event types</option>
          {AUDIT_ACTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {audit.error && (
        <ErrorBanner role="alert" className="mb-4">
          Unable to load team activity.{" "}
          <Button size="xs" variant="outline" onClick={() => void audit.retry()}>
            Retry
          </Button>
        </ErrorBanner>
      )}
      {audit.loading ? (
        <p role="status" className="py-12 text-center text-sm text-muted-foreground">
          Loading activity...
        </p>
      ) : audit.events.length === 0 && !audit.error ? (
        <div className="rounded-md border border-dashed border-border py-12 text-center">
          <p className="text-sm text-muted-foreground">No matching team events.</p>
        </div>
      ) : (
        <ul className="min-w-0 divide-y divide-border-muted rounded-md border border-border-muted">
          {audit.events.map((event) => (
            <AuditEventCard key={event.id} event={event} />
          ))}
        </ul>
      )}
      {(audit.events.length > 0 || audit.hasPrevious) && (
        <nav
          aria-label="Team activity pagination"
          className="mt-4 flex items-center justify-between gap-3"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={!audit.hasPrevious || audit.loading || audit.validating}
            onClick={audit.previous}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Page {audit.page}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!audit.hasNext || audit.loading || audit.validating || !!audit.error}
            onClick={audit.next}
          >
            Next
          </Button>
        </nav>
      )}
    </section>
  );
}
