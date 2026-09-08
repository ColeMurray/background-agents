"use client";

import { useEffect, useRef } from "react";
import type { AuditEvent, AuditOperationResult } from "@open-inspect/shared/types/audit-events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuditEvents } from "@/hooks/use-audit-events";
import { formatRelativeTime } from "@/lib/time";

const OUTCOMES: Record<AuditOperationResult, { label: string; className: string }> = {
  applied: { label: "Applied", className: "bg-success-muted text-success" },
  no_op: { label: "No change", className: "bg-muted text-muted-foreground" },
  denied: { label: "Denied", className: "bg-destructive-muted text-destructive" },
  rejected: { label: "Rejected", className: "bg-warning-muted text-warning" },
};

const ACTION_LABELS: Record<string, string> = {
  "authorization.request_allowed": "Request authorized",
  "authorization.request_denied": "Request denied",
  "workspace.member_role_updated": "Member role updated",
  "workspace.member_status_updated": "Member status updated",
};

function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function actorSummary(event: AuditEvent): string {
  if (event.actorServiceSnapshot && event.actorUserIdSnapshot) {
    return `Service / ${event.actorServiceSnapshot} / User actor / ${event.actorUserIdSnapshot}`;
  }
  if (event.actorServiceSnapshot) return `Service / ${event.actorServiceSnapshot}`;
  if (event.actorUserIdSnapshot) return `User / ${event.actorUserIdSnapshot}`;
  return `${event.principalKind.charAt(0).toUpperCase()}${event.principalKind.slice(1)} principal`;
}

function resourceSummary(event: AuditEvent): string {
  const resource = event.resourceId
    ? `${event.resourceType} / ${event.resourceId}`
    : event.resourceType;
  return event.targetUserIdSnapshot
    ? `${resource} / Target user ${event.targetUserIdSnapshot}`
    : resource;
}

function AuditEventCard({ event }: { event: AuditEvent }) {
  const outcome = OUTCOMES[event.operationResult];
  const localTimestamp = new Date(event.occurredAt).toLocaleString();

  return (
    <li className="min-w-0 px-4 py-4 sm:px-5">
      <article aria-labelledby={`audit-event-${event.id}`}>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 id={`audit-event-${event.id}`} className="text-sm font-medium text-foreground">
              {auditActionLabel(event.action)}
            </h3>
            <time
              dateTime={new Date(event.occurredAt).toISOString()}
              title={localTimestamp}
              className="mt-0.5 block text-xs text-muted-foreground"
            >
              {localTimestamp} / {formatRelativeTime(event.occurredAt)}
            </time>
          </div>
          <Badge className={`w-fit shrink-0 ${outcome.className}`}>{outcome.label}</Badge>
        </div>

        <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-muted-foreground">Actor</dt>
            <dd className="break-words font-mono text-foreground">{actorSummary(event)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Resource</dt>
            <dd className="break-words font-mono text-foreground">{resourceSummary(event)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Request</dt>
            <dd className="break-all font-mono text-foreground">{event.requestId}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Reason</dt>
            <dd className="break-words font-mono text-foreground">{event.reasonCode}</dd>
          </div>
        </dl>

        <details className="mt-3 text-xs">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Structured details
          </summary>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[11px] leading-5 text-foreground">
            {JSON.stringify(
              {
                eventId: event.id,
                action: event.action,
                principalKind: event.principalKind,
                metadata: event.metadata,
              },
              null,
              2
            )}
          </pre>
        </details>
      </article>
    </li>
  );
}

/** Read-only, cursor-paginated view of durable workspace audit events. */
export function AuditLogSettings() {
  const audit = useAuditEvents();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterPaginationRef = useRef(false);

  useEffect(() => {
    if (!focusAfterPaginationRef.current || audit.loading || audit.error) return;
    focusAfterPaginationRef.current = false;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: "start" });
  }, [audit.error, audit.loading, audit.page]);

  const changePage = (navigate: () => void) => {
    focusAfterPaginationRef.current = true;
    navigate();
  };

  return (
    <section aria-labelledby="audit-log-heading">
      <h2
        ref={headingRef}
        id="audit-log-heading"
        tabIndex={-1}
        className="mb-1 rounded-sm text-xl font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Audit log
      </h2>
      <p className="mb-6 text-sm text-muted-foreground">
        Review workspace operations and authorization decisions. Events are shown newest first.
      </p>

      {audit.error && audit.events.length > 0 && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive-border px-4 py-3"
        >
          <p className="text-sm text-destructive">
            Unable to refresh the audit log. Showing the most recently loaded events.
          </p>
          <Button size="sm" variant="outline" onClick={() => void audit.retry()}>
            Retry
          </Button>
        </div>
      )}

      {audit.loading ? (
        <div className="rounded-md border border-border-muted py-12 text-center" aria-live="polite">
          <div
            className="mx-auto size-6 animate-spin rounded-full border-2 border-current border-t-transparent text-muted-foreground"
            aria-hidden="true"
          />
          <p className="mt-3 text-sm text-muted-foreground">Loading audit events...</p>
        </div>
      ) : audit.error && audit.events.length === 0 ? (
        <div role="alert" className="rounded-md border border-destructive-border p-5">
          <p className="text-sm font-medium text-destructive">Unable to load the audit log.</p>
          <p className="mt-1 text-xs text-muted-foreground">Try the request again.</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => void audit.retry()}>
            Retry
          </Button>
        </div>
      ) : audit.events.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium text-foreground">No audit events yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Workspace activity will appear here as it is recorded.
          </p>
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
          className="mt-4 flex items-center justify-between gap-3"
          aria-label="Audit log pagination"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={!audit.hasPrevious || audit.loading || audit.validating}
            onClick={() => changePage(audit.previous)}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Page {audit.page}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!audit.hasNext || audit.loading || audit.validating || Boolean(audit.error)}
            onClick={() => changePage(audit.next)}
          >
            Next
          </Button>
        </nav>
      )}
    </section>
  );
}
