"use client";

import { useId, useState } from "react";
import { useSWRConfig } from "swr";
import { sessionVisibilitySchema, type SessionVisibility } from "@open-inspect/shared/types/teams";
import { useTeamMembers } from "@/hooks/use-teams";
import { SessionScopeError, updateSessionScope } from "@/lib/session-scope";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ErrorBanner } from "./ui/error-banner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface SessionVisibilityControlProps {
  sessionId: string;
  ownerTeamId: string | null;
  ownerUserId: string | null;
  visibility: SessionVisibility;
  canChangeVisibility: boolean;
  onUpdated: () => Promise<void>;
}

/** Membership is only an access warning; server session capabilities authorize the mutation. */
export function SessionTeamOwnerWarning({
  teamId,
  ownerUserId,
}: {
  teamId: string;
  ownerUserId: string | null;
}) {
  const { members, loading, error } = useTeamMembers(teamId);
  if (loading)
    return <p className="text-xs text-muted-foreground">Checking session owner membership...</p>;
  if (error)
    return (
      <p className="text-xs text-muted-foreground">
        Unable to verify the session owner&apos;s team membership.
      </p>
    );
  if (!ownerUserId || members.some((member) => member.userId === ownerUserId)) return null;
  return (
    <p className="text-sm text-muted-foreground" role="status">
      The session owner is not a member of this team and may lose access with team visibility.
    </p>
  );
}

export function SessionVisibilityControl({
  sessionId,
  ownerTeamId,
  ownerUserId,
  visibility,
  canChangeVisibility,
  onUpdated,
}: SessionVisibilityControlProps) {
  const { mutate, cache } = useSWRConfig();
  const id = useId();
  // Untouched controls follow refreshed snapshots; dirty selections remain until applied.
  const [selection, setSelection] = useState<SessionVisibility | null>(null);
  const selected = selection ?? visibility;
  const [includeChildren, setIncludeChildren] = useState(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const disabled =
    !canChangeVisibility ||
    pending ||
    (selected === "team" && !ownerTeamId) ||
    (selected === "private" && !ownerUserId);

  async function changeVisibility(children: boolean) {
    if (disabled) return;
    setPending(true);
    setFailure(null);
    setIncludeChildren(children);
    try {
      await updateSessionScope(
        `/api/sessions/${encodeURIComponent(sessionId)}/visibility`,
        {
          method: "PUT",
          body: { visibility: selected, includeChildren: children },
        },
        onUpdated,
        { mutate, cache }
      );
      setSelection(null);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause : new Error("Failed to change visibility"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={`${id}-visibility`} className="text-sm font-medium">
          Visibility
        </label>
        <Select
          value={selected}
          disabled={!canChangeVisibility || pending}
          onValueChange={(value) => {
            const parsed = sessionVisibilitySchema.safeParse(value);
            if (parsed.success) {
              setSelection(parsed.data);
              setFailure(null);
            }
          }}
        >
          <SelectTrigger id={`${id}-visibility`} density="compact" className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent onEscapeKeyDown={(event) => event.stopPropagation()}>
            <SelectItem value="workspace">Workspace</SelectItem>
            <SelectItem value="team" disabled={!ownerTeamId}>
              Team
            </SelectItem>
            <SelectItem value="private" disabled={!ownerUserId}>
              Private
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {selected === "team" && ownerTeamId && (
        <SessionTeamOwnerWarning teamId={ownerTeamId} ownerUserId={ownerUserId} />
      )}
      {failure && <ErrorBanner role="alert">{failure.message}</ErrorBanner>}
      <div className="flex items-center justify-between gap-2">
        <label
          className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
          htmlFor={`${id}-children`}
        >
          <Checkbox
            id={`${id}-children`}
            checked={includeChildren}
            disabled={!canChangeVisibility || pending}
            onCheckedChange={(checked) => {
              setIncludeChildren(checked === true);
              setFailure(null);
            }}
            className="h-3.5 w-3.5 shrink-0"
          />
          Include child sessions
        </label>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-7 shrink-0 rounded-sm"
          disabled={disabled}
          onClick={() => void changeVisibility(includeChildren)}
        >
          {pending ? "Updating..." : "Save"}
        </Button>
      </div>
      {includeChildren &&
        failure instanceof SessionScopeError &&
        failure.canRetryWithoutChildren && (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => void changeVisibility(false)}
          >
            Retry without child sessions
          </Button>
        )}
    </div>
  );
}
