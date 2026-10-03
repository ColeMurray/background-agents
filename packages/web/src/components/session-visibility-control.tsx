"use client";

import { useId, useState } from "react";
import { useSWRConfig } from "swr";
import { sessionVisibilitySchema, type SessionVisibility } from "@open-inspect/shared/types/teams";
import { useTeamMembers } from "@/hooks/use-teams";
import { SessionScopeError, updateSessionScope } from "@/lib/session-scope";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
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
  // Holds the in-flight or failed selection; otherwise the control follows refreshed snapshots.
  const [selection, setSelection] = useState<SessionVisibility | null>(null);
  const selected = selection ?? visibility;
  const [includeChildren, setIncludeChildren] = useState(true);
  const [confirm, setConfirm] = useState<{
    target: SessionVisibility;
    children: boolean;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const editable = canChangeVisibility && !pending;

  function isAllowed(target: SessionVisibility) {
    return (target !== "team" || !!ownerTeamId) && (target !== "private" || !!ownerUserId);
  }

  async function changeVisibility(target: SessionVisibility, children: boolean) {
    if (!editable || !isAllowed(target)) return;
    const previousChildren = includeChildren;
    setPending(true);
    setFailure(null);
    setSelection(target);
    setIncludeChildren(children);
    try {
      await updateSessionScope(
        `/api/sessions/${encodeURIComponent(sessionId)}/visibility`,
        {
          method: "PUT",
          body: { visibility: target, includeChildren: children },
        },
        onUpdated,
        { mutate, cache }
      );
      setSelection(null);
    } catch (cause) {
      // Keep the failed attempt only when "Retry without child sessions" is offered.
      if (!(children && cause instanceof SessionScopeError && cause.canRetryWithoutChildren)) {
        setSelection(null);
        setIncludeChildren(previousChildren);
      }
      setFailure(cause instanceof Error ? cause : new Error("Failed to change visibility"));
    } finally {
      setPending(false);
    }
  }

  /**
   * Cascading a non-private visibility can expose private children, and team visibility can
   * revoke the owner's access, so both require confirmation.
   */
  function requestChange(target: SessionVisibility, children: boolean) {
    setFailure(null);
    if ((children && target !== "private") || target === "team") setConfirm({ target, children });
    else void changeVisibility(target, children);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={`${id}-visibility`} className="text-sm font-medium">
          Visibility
        </label>
        <Select
          value={selected}
          disabled={!editable}
          onValueChange={(value) => {
            const parsed = sessionVisibilitySchema.safeParse(value);
            if (parsed.success && parsed.data !== selected)
              requestChange(parsed.data, includeChildren);
          }}
        >
          <SelectTrigger id={`${id}-visibility`} density="compact" className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
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
            disabled={!editable}
            onCheckedChange={(checked) => {
              // Checking applies the current visibility to children; unchecking only scopes
              // future changes to this session.
              if (checked === true) requestChange(selected, true);
              else {
                // Dismissing a retryable cascade failure discards its unsaved target.
                if (failure) setSelection(null);
                setIncludeChildren(false);
                setFailure(null);
              }
            }}
            className="h-3.5 w-3.5 shrink-0"
          />
          Include child sessions
        </label>
        {pending && <span className="text-xs text-muted-foreground">Updating...</span>}
      </div>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.children
                ? "Change child session visibility?"
                : "Change session visibility?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.children
                ? `This will change this session and any child sessions to ${confirm.target} visibility. Any private child sessions will change to ${confirm.target} visibility.`
                : `This will change this session to ${confirm?.target} visibility.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.target === "team" && ownerTeamId && (
            <SessionTeamOwnerWarning teamId={ownerTeamId} ownerUserId={ownerUserId} />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!editable}
              onClick={() => {
                if (confirm) void changeVisibility(confirm.target, confirm.children);
              }}
            >
              Change visibility
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {includeChildren &&
        failure instanceof SessionScopeError &&
        failure.canRetryWithoutChildren && (
          <Button
            size="xs"
            variant="outline"
            disabled={!editable}
            onClick={() => void changeVisibility(selected, false)}
          >
            Retry without child sessions
          </Button>
        )}
    </div>
  );
}
