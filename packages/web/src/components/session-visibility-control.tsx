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
  const [confirmChildren, setConfirmChildren] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const disabled =
    !canChangeVisibility ||
    pending ||
    selected === visibility ||
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
      <label htmlFor={`${id}-visibility`} className="text-sm font-medium">
        Visibility
      </label>
      <select
        id={`${id}-visibility`}
        value={selected}
        disabled={!canChangeVisibility || pending}
        onChange={(event) => {
          const parsed = sessionVisibilitySchema.safeParse(event.target.value);
          if (parsed.success) {
            setSelection(parsed.data);
            setFailure(null);
            setConfirmChildren(false);
          }
        }}
        className="w-full rounded border border-border bg-background px-2 py-2 text-sm disabled:opacity-50"
      >
        <option value="workspace">Workspace</option>
        <option value="team" disabled={!ownerTeamId}>
          Team
        </option>
        <option value="private" disabled={!ownerUserId}>
          Private
        </option>
      </select>
      <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-children`}>
        <Checkbox
          id={`${id}-children`}
          checked={includeChildren}
          disabled={!canChangeVisibility || pending}
          onCheckedChange={(checked) => {
            setIncludeChildren(checked === true);
            setFailure(null);
            setConfirmChildren(false);
          }}
        />
        Include child sessions
      </label>
      {selected === "team" && ownerTeamId && (
        <SessionTeamOwnerWarning teamId={ownerTeamId} ownerUserId={ownerUserId} />
      )}
      {failure && <ErrorBanner role="alert">{failure.message}</ErrorBanner>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled}
          onClick={() => {
            if (includeChildren && selected !== "private") setConfirmChildren(true);
            else void changeVisibility(includeChildren);
          }}
        >
          {pending ? "Updating..." : "Change visibility"}
        </Button>
        {includeChildren &&
          failure instanceof SessionScopeError &&
          failure.canRetryWithoutChildren && (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => void changeVisibility(false)}
            >
              Retry without child sessions
            </Button>
          )}
      </div>
      <AlertDialog open={confirmChildren} onOpenChange={setConfirmChildren}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change child session visibility?</AlertDialogTitle>
            <AlertDialogDescription>
              This will change this session and its child sessions to {selected} visibility. Private
              child sessions will change to {selected} visibility.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={disabled} onClick={() => void changeVisibility(true)}>
              Change visibility
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
