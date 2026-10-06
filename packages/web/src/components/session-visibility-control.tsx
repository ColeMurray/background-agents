"use client";

import { useId, useState } from "react";
import { useSWRConfig } from "swr";
import { sessionVisibilitySchema, type SessionVisibility } from "@open-inspect/shared/types/teams";
import { useTeamMembers } from "@/hooks/use-teams";
import {
  SessionScopeError,
  SessionScopeRefreshError,
  updateSessionScope,
} from "@/lib/session-scope";
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
import { useSessionScopeState } from "./session-scope-provider";

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
  const {
    state: { visibilitySelection, pending, visibilityFailure, refreshFailure },
    setState,
  } = useSessionScopeState();
  // Retain an acknowledged target if refreshing the snapshot fails.
  const selected = visibilitySelection ?? visibility;
  const [confirm, setConfirm] = useState<{
    target: SessionVisibility;
    includeChildren: boolean;
    chooseChildren: boolean;
  } | null>(null);
  const editable = canChangeVisibility && !pending && !refreshFailure;

  function isAllowed(target: SessionVisibility) {
    return (target !== "team" || !!ownerTeamId) && (target !== "private" || !!ownerUserId);
  }

  async function changeVisibility(target: SessionVisibility, children: boolean) {
    if (!editable || !isAllowed(target)) return;
    setState({
      visibilitySelection: target,
      pending: true,
      visibilityFailure: null,
      refreshFailure: null,
    });
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
      setState({
        visibilitySelection: null,
        pending: false,
        visibilityFailure: null,
        refreshFailure: null,
      });
    } catch (cause) {
      const saved = cause instanceof SessionScopeRefreshError;
      setState({
        visibilitySelection: saved ? target : visibilitySelection,
        pending: false,
        refreshFailure: saved ? cause : null,
        visibilityFailure: saved
          ? null
          : {
              target,
              includedChildren: children,
              error: cause instanceof Error ? cause : new Error("Failed to change visibility"),
            },
      });
    }
  }

  // Keep the acknowledged visibility visible when snapshot errors revoke capabilities.
  if (
    !canChangeVisibility &&
    !pending &&
    !visibilityFailure &&
    !confirm &&
    visibilitySelection === null
  )
    return null;

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
              setConfirm({ target: parsed.data, includeChildren: false, chooseChildren: true });
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
      {visibilityFailure && (
        <ErrorBanner role="alert">{visibilityFailure.error.message}</ErrorBanner>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!editable}
          onClick={() =>
            setConfirm({ target: selected, includeChildren: true, chooseChildren: false })
          }
        >
          Apply to child sessions
        </Button>
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
              {confirm?.includeChildren
                ? "Change child session visibility?"
                : "Change session visibility?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.includeChildren
                ? `This will change this session and any child sessions to ${confirm.target} visibility. Any private child sessions will change to ${confirm.target} visibility.`
                : `This will change this session to ${confirm?.target} visibility.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.chooseChildren && (
            <label
              htmlFor={`${id}-children`}
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Checkbox
                id={`${id}-children`}
                checked={confirm.includeChildren}
                disabled={!editable}
                onCheckedChange={(checked) =>
                  setConfirm({ ...confirm, includeChildren: checked === true })
                }
              />
              Also change child sessions
            </label>
          )}
          {confirm?.target === "team" && ownerTeamId && (
            <SessionTeamOwnerWarning teamId={ownerTeamId} ownerUserId={ownerUserId} />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!editable}
              onClick={() => {
                if (confirm) void changeVisibility(confirm.target, confirm.includeChildren);
              }}
            >
              Change visibility
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {visibilityFailure?.includedChildren &&
        visibilityFailure.error instanceof SessionScopeError &&
        visibilityFailure.error.canRetryWithoutChildren && (
          <Button
            size="xs"
            variant="outline"
            disabled={!editable}
            onClick={() =>
              setConfirm({
                target: visibilityFailure.target,
                includeChildren: false,
                chooseChildren: false,
              })
            }
          >
            Retry without child sessions
          </Button>
        )}
    </div>
  );
}
