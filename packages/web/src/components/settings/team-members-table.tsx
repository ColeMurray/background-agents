"use client";

import { useState } from "react";
import type { TeamMember, TeamResponse } from "@/hooks/use-teams";
import { useTeamMemberCandidates, useTeamMembers } from "@/hooks/use-teams";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { UserIdentity, UserIdentityPicker, userDisplayName } from "@/components/user-identity";

export function TeamMembersTable({ team, members }: { team: TeamResponse; members: TeamMember[] }) {
  const capabilities = useTeamCapabilities(team);
  const { hasPermission } = useCurrentUserAuthorization();
  const { candidates, loading, error } = useTeamMemberCandidates(
    capabilities.canManageMembers && hasPermission("workspace.members.read")
  );
  const { setMember, removeMember } = useTeamMembers(team.id);
  const [userId, setUserId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(action: () => Promise<void>) {
    setPending(true);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Membership update failed");
    } finally {
      setPending(false);
    }
  }

  const available = candidates.filter(
    (candidate) =>
      !members.some((member) => member.userId === candidate.userId) &&
      candidate.suspendedAt === null
  );
  return (
    <div className="space-y-4">
      {message && <ErrorBanner>{message}</ErrorBanner>}
      <div className="divide-y divide-border rounded-lg border border-border">
        {members.length === 0 && <p className="p-4 text-sm text-muted-foreground">No members.</p>}
        {members.map((member) => {
          const name = userDisplayName(member);
          return (
            <div
              key={member.userId}
              className="grid gap-3 p-4 sm:grid-cols-[1fr_8rem_auto] sm:items-center"
            >
              <UserIdentity {...member} />
              <select
                aria-label={`Role for ${name}`}
                value={member.role}
                disabled={!capabilities.canManageMembers || pending}
                onChange={(event) =>
                  void run(() =>
                    setMember(member.userId, event.target.value === "lead" ? "lead" : "member")
                  )
                }
                className="rounded border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              >
                <option value="member">Member</option>
                <option value="lead">Lead</option>
              </select>
              <Button
                variant="outline"
                disabled={!capabilities.canManageMembers || pending}
                onClick={() => void run(() => removeMember(member.userId))}
                aria-label={`Remove ${name}`}
              >
                Remove
              </Button>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="add-team-member" className="text-sm font-medium">
          Add member
        </label>
        {hasPermission("workspace.members.read") ? (
          <UserIdentityPicker
            id="add-team-member"
            value={userId}
            disabled={!capabilities.canManageMembers || pending || loading || !!error}
            onValueChange={setUserId}
            candidates={available}
          />
        ) : (
          <input
            id="add-team-member"
            value={userId}
            disabled={!capabilities.canManageMembers || pending}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="Workspace user ID"
            className="min-w-48 flex-1 rounded border border-border bg-background px-2 py-2 text-sm"
          />
        )}
        <Button
          disabled={!userId || pending || !capabilities.canManageMembers}
          onClick={() =>
            void run(async () => {
              await setMember(userId, "member");
              setUserId("");
            })
          }
        >
          Add
        </Button>
        {error && <ErrorBanner>Failed to load workspace members.</ErrorBanner>}
        {!hasPermission("workspace.members.read") && (
          <p className="text-xs text-muted-foreground">
            Enter a known workspace user ID to add them.
          </p>
        )}
      </div>
    </div>
  );
}
