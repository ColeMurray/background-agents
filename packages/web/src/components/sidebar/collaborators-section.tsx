"use client";

import { useId, useState } from "react";
import { useSWRConfig } from "swr";
import { useSessionCollaboratorCandidates } from "@/hooks/use-session-collaborator-candidates";
import { updateSessionScope } from "@/lib/session-scope";
import { Button } from "../ui/button";
import { ErrorBanner } from "../ui/error-banner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { UserIdentity, userDisplayName } from "../user-identity";
import { CollapsibleSection } from "./collapsible-section";

export interface CollaboratorsSectionProps {
  sessionId: string;
  ownerUserId: string | null;
  collaborators: string[];
  canManageCollaborators: boolean;
  onUpdated: () => Promise<void>;
}

/** Render for private sessions only; the parent must pass the server capability unchanged. */
export function CollaboratorsSection({
  sessionId,
  ownerUserId,
  collaborators,
  canManageCollaborators,
  onUpdated,
}: CollaboratorsSectionProps) {
  const { mutate, cache } = useSWRConfig();
  const { candidates, loading, error } = useSessionCollaboratorCandidates(
    sessionId,
    canManageCollaborators
  );
  const id = useId();
  const [userId, setUserId] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const available = candidates.filter(
    (candidate) => candidate.userId !== ownerUserId && !collaborators.includes(candidate.userId)
  );

  async function updateCollaborator(targetUserId: string, remove: boolean) {
    if (!canManageCollaborators || pending || targetUserId === ownerUserId) return;
    if (
      remove
        ? !collaborators.includes(targetUserId)
        : loading || !!error || !available.some((candidate) => candidate.userId === targetUserId)
    )
      return;
    setPending(true);
    setMessage(null);
    try {
      await updateSessionScope(
        `/api/sessions/${encodeURIComponent(sessionId)}/collaborators/${encodeURIComponent(targetUserId)}`,
        {
          method: remove ? "DELETE" : "PUT",
        },
        onUpdated,
        { mutate, cache }
      );
      if (!remove) setUserId("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Failed to update collaborator");
    } finally {
      setPending(false);
    }
  }

  if (!canManageCollaborators) return null;
  return (
    <CollapsibleSection title="Collaborators">
      <div className="space-y-3">
        {collaborators.length === 0 && (
          <p className="text-xs text-muted-foreground">No collaborators.</p>
        )}
        {collaborators.map((collaboratorId) => {
          const candidate = candidates.find((candidate) => candidate.userId === collaboratorId);
          const user = candidate ?? { userId: collaboratorId };
          const name = userDisplayName(user);
          return (
            <div key={collaboratorId} className="flex items-center justify-between gap-2">
              <UserIdentity {...user} />
              <Button
                size="sm"
                variant="outline"
                disabled={pending || collaboratorId === ownerUserId}
                aria-label={`Remove ${name}`}
                onClick={() => void updateCollaborator(collaboratorId, true)}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <label htmlFor={`${id}-add`} className="block text-xs font-medium">
          Add collaborator
        </label>
        <div className="flex flex-wrap gap-2">
          <Select value={userId} disabled={pending || loading || !!error} onValueChange={setUserId}>
            <SelectTrigger id={`${id}-add`} className="min-w-0 flex-1">
              <SelectValue placeholder="Select a workspace member" />
            </SelectTrigger>
            <SelectContent>
              {available.map((candidate) => (
                <SelectItem
                  className="group focus:bg-muted focus:text-foreground"
                  key={candidate.userId}
                  value={candidate.userId}
                  textValue={userDisplayName(candidate)}
                >
                  <UserIdentity {...candidate} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={
              pending ||
              loading ||
              !!error ||
              !available.some((candidate) => candidate.userId === userId)
            }
            onClick={() => void updateCollaborator(userId, false)}
          >
            Add
          </Button>
        </div>
        {error && <ErrorBanner role="alert">Failed to load workspace members.</ErrorBanner>}
        {message && <ErrorBanner role="alert">{message}</ErrorBanner>}
      </div>
    </CollapsibleSection>
  );
}
