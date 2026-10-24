"use client";

import { useState } from "react";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useSessionExternalActions } from "@/hooks/use-session-external-actions";
import type { ExternalActionPending } from "@open-inspect/shared/types/external-actions";
import { Button } from "../ui/button";
import { CollapsibleSection } from "./collapsible-section";

const MAX_PREVIEW_CHARACTERS = 400;

export interface ExternalActionsSectionProps {
  sessionId: string;
  /** Whether the deployment currently exposes external actions at all. */
  enabled: boolean;
}

/**
 * Approvals for external effects this session wants to publish.
 *
 * The list and every decision come from the control plane, which owns the
 * approval ledger and the session's authority. The browser only renders what
 * it is told and reports what the server refuses.
 */
export function ExternalActionsSection({ sessionId, enabled }: ExternalActionsSectionProps) {
  const { hasPermission } = useCurrentUserAuthorization();
  const canDecide = hasPermission("external_actions.approve");
  const { actions, error, isLoading, decide } = useSessionExternalActions(sessionId, enabled);

  if (!enabled) return null;
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading approvals…</p>;
  if (error)
    return (
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
    );
  if (actions.length === 0)
    return <p className="text-xs text-muted-foreground">No external effects are waiting.</p>;

  return (
    <CollapsibleSection title="Approvals">
      <ul className="space-y-3">
        {actions.map((action) => (
          <ExternalActionItem
            key={action.id}
            action={action}
            canDecide={canDecide}
            onDecide={decide}
          />
        ))}
      </ul>
    </CollapsibleSection>
  );
}

function ExternalActionItem({
  action,
  canDecide,
  onDecide,
}: {
  action: ExternalActionPending;
  canDecide: boolean;
  onDecide: (
    actionId: string,
    decision: "approve" | "deny" | "cancel",
    reason?: string
  ) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const decide = async (decision: "approve" | "deny" | "cancel") => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onDecide(action.id, decision);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The decision was not accepted");
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="space-y-2 rounded-sm border border-border p-2">
      <p className="text-xs font-medium text-foreground">{action.summary}</p>
      <p className="text-xs text-muted-foreground">
        {action.provider} · {action.action} · {stateLabel(action.state)}
      </p>
      {Object.keys(action.target).length > 0 && (
        <p className="text-xs text-muted-foreground">{describeTarget(action.target)}</p>
      )}
      {Object.keys(action.arguments).length > 0 && (
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-2 text-xs text-foreground">
          {previewArguments(action.arguments)}
        </pre>
      )}
      {action.expiresAt !== null && (
        <p className="text-xs text-muted-foreground">
          Expires {new Date(action.expiresAt).toLocaleString()}
        </p>
      )}
      {canDecide && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() => void decide("approve")}
            aria-label={`Approve ${action.summary}`}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void decide("deny")}
            aria-label={`Deny ${action.summary}`}
          >
            Deny
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void decide("cancel")}
            aria-label={`Cancel ${action.summary}`}
          >
            Cancel
          </Button>
        </div>
      )}
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </li>
  );
}

function stateLabel(state: ExternalActionPending["state"]): string {
  switch (state) {
    case "awaiting_approval":
      return "waiting for approval";
    case "approved":
      return "approved";
    case "executing":
      return "running";
    case "indeterminate":
      return "outcome unknown";
    default:
      return state;
  }
}

function describeTarget(target: Record<string, unknown>): string {
  return Object.entries(target)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

function previewArguments(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, null, 2);
  return text.length > MAX_PREVIEW_CHARACTERS ? `${text.slice(0, MAX_PREVIEW_CHARACTERS)}…` : text;
}
