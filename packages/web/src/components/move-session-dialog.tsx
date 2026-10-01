"use client";

import { useId, useState } from "react";
import { useSWRConfig } from "swr";
import { teamCapabilitiesSchema, type SessionVisibility } from "@open-inspect/shared/types/teams";
import { useMeTeams, useTeams } from "@/hooks/use-teams";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import {
  SessionScopeError,
  updateSessionScope,
  type SessionScopeControls,
} from "@/lib/session-scope";
import { SessionTeamOwnerWarning } from "./session-visibility-control";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { ErrorBanner } from "./ui/error-banner";

export interface MoveSessionDialogProps {
  sessionId: string;
  ownerTeamId: string | null;
  ownerUserId: string | null;
  visibility: SessionVisibility;
  slackThread?: SessionScopeControls["slackThread"];
  canMove: boolean;
  onUpdated: () => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MoveSessionDialog(props: MoveSessionDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && <MoveSessionForm key={props.sessionId} {...props} />}
    </Dialog>
  );
}

function MoveSessionForm({
  sessionId,
  ownerTeamId,
  ownerUserId,
  visibility,
  slackThread,
  canMove,
  onUpdated,
  onOpenChange,
}: MoveSessionDialogProps) {
  const { teams, loading, error } = useTeams();
  const membership = useMeTeams();
  const { mutate, cache } = useSWRConfig();
  const id = useId();
  const [teamId, setTeamId] = useState(ownerTeamId ?? "");
  const [includeChildren, setIncludeChildren] = useState(true);
  const [joinTeam, setJoinTeam] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const target = teams.find((team) => team.id === teamId);
  const capabilities = useTeamCapabilities(target);
  const isMember = membership.teams.some((team) => team.id === teamId);
  const canJoin =
    !loading &&
    !error &&
    !membership.loading &&
    !membership.error &&
    target?.joinPolicy === "open" &&
    !isMember &&
    capabilities.canJoin;
  const targetAllowed =
    !teamId ||
    (target?.archivedAt === null &&
      teamCapabilitiesSchema.safeParse(target.capabilities).success &&
      (isMember || (canJoin && joinTeam)));
  const disabled =
    !canMove ||
    pending ||
    loading ||
    membership.loading ||
    !!error ||
    !!membership.error ||
    !targetAllowed;
  const activeTeams = teams.filter((team) => team.archivedAt === null);

  async function move(children: boolean) {
    if (disabled) return;
    setPending(true);
    setFailure(null);
    setIncludeChildren(children);
    try {
      await updateSessionScope(
        `/api/sessions/${encodeURIComponent(sessionId)}/scope`,
        {
          method: "PUT",
          body: {
            teamId: teamId || null,
            includeChildren: children,
            joinTeam: canJoin && joinTeam,
          },
        },
        onUpdated,
        { mutate, cache }
      );
      onOpenChange(false);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause : new Error("Failed to move session"));
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogTitle>Move session</DialogTitle>
      <DialogDescription>Move this session to a team or back to the workspace.</DialogDescription>
      <div className="space-y-2">
        <label htmlFor={`${id}-destination`} className="text-sm font-medium">
          Destination
        </label>
        <select
          id={`${id}-destination`}
          value={teamId}
          disabled={
            !canMove || pending || loading || membership.loading || !!error || !!membership.error
          }
          onChange={(event) => {
            setTeamId(event.target.value);
            setJoinTeam(false);
            setFailure(null);
          }}
          className="w-full rounded border border-border bg-background px-2 py-2 text-sm disabled:opacity-50"
        >
          <option value="">Workspace (no team)</option>
          {teamId && !activeTeams.some((team) => team.id === teamId) && (
            <option value={teamId} disabled>
              Current team unavailable
            </option>
          )}
          {activeTeams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </div>
      {(error || membership.error) && (
        <ErrorBanner role="alert">Failed to load teams and memberships.</ErrorBanner>
      )}
      {canJoin && (
        <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-join`}>
          <Checkbox
            id={`${id}-join`}
            checked={joinTeam}
            disabled={!canMove || pending}
            onCheckedChange={(checked) => setJoinTeam(checked === true)}
          />
          Join target team
        </label>
      )}
      <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-children`}>
        <Checkbox
          id={`${id}-children`}
          checked={includeChildren}
          disabled={!canMove || pending}
          onCheckedChange={(checked) => {
            setIncludeChildren(checked === true);
            setFailure(null);
          }}
        />
        Include child sessions
      </label>
      {visibility === "team" && target && (
        <SessionTeamOwnerWarning teamId={target.id} ownerUserId={ownerUserId} />
      )}
      {visibility === "team" && !teamId && (
        <p className="text-sm text-muted-foreground">
          Team visibility will change to workspace visibility when removing the team.
        </p>
      )}
      {slackThread && slackThread.teamId !== null && slackThread.teamId !== (teamId || null) && (
        <p
          role="status"
          className="rounded border border-warning/30 bg-warning-muted p-3 text-sm text-foreground"
        >
          This Slack channel is bound to a team other than the selected destination. Moving this
          session will end the Slack thread. Future work will continue in the web app.
        </p>
      )}
      {failure && <ErrorBanner role="alert">{failure.message}</ErrorBanner>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        {includeChildren &&
          failure instanceof SessionScopeError &&
          failure.canRetryWithoutChildren && (
            <Button variant="outline" disabled={disabled} onClick={() => void move(false)}>
              Retry without child sessions
            </Button>
          )}
        <Button disabled={disabled} onClick={() => void move(includeChildren)}>
          {pending ? "Moving..." : "Move session"}
        </Button>
      </div>
    </DialogContent>
  );
}
