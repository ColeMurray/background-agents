"use client";

import { useState } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Button } from "@/components/ui/button";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useWorkspaceAdministration } from "@/hooks/use-workspace-administration";

/**
 * Shows workspace members and roles, exposing member controls only when the user may manage them.
 */
export function WorkspaceSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canReadMembers = hasPermission("workspace.members.read");
  const canReadRoles = hasPermission("workspace.roles.read");
  const canManage = hasPermission("workspace.members.manage");
  const canAssignRoles = canManage && canReadRoles;
  const canTransfer = hasPermission("workspace.transfer_ownership");
  const { members, roles, loading, error, updateMember } = useWorkspaceAdministration({
    readMembers: canReadMembers,
    readRoles: canReadRoles,
  });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(() => new Set());
  const unsuspendedOwnerCount = members.filter(
    (member) => member.role.key === "owner" && member.suspendedAt === null
  ).length;

  if (loading) return <p className="text-sm text-muted-foreground">Loading workspace access...</p>;
  if (error) return <ErrorBanner>Failed to load workspace access.</ErrorBanner>;

  async function mutate(memberId: string, action: () => Promise<void>) {
    setMutationError(null);
    setPendingMemberIds((current) => new Set(current).add(memberId));
    try {
      await action();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Workspace update failed");
    } finally {
      setPendingMemberIds((current) => {
        const next = new Set(current);
        next.delete(memberId);
        return next;
      });
    }
  }

  return (
    <div className="space-y-10">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Workspace access</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign one role to each canonical user. Backend authorization remains authoritative.
        </p>
      </div>

      {mutationError && <ErrorBanner>{mutationError}</ErrorBanner>}

      {canReadMembers && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Members
          </h3>
          <div className="divide-y divide-border rounded-lg border border-border">
            {members.map((member) => (
              <div
                key={member.userId}
                className="grid gap-3 p-4 sm:grid-cols-[1fr_12rem_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {member.displayName ?? member.email ?? member.userId}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.email ?? member.userId}
                  </p>
                </div>
                {canAssignRoles &&
                (member.role.key !== "owner" ||
                  (canTransfer &&
                    !(member.suspendedAt === null && unsuspendedOwnerCount === 1))) ? (
                  <select
                    aria-label={`Role for ${member.displayName ?? member.userId}`}
                    value={member.role.id}
                    disabled={pendingMemberIds.has(member.userId)}
                    onChange={(event) =>
                      void mutate(member.userId, () =>
                        updateMember(member, { kind: "role", roleId: event.target.value })
                      )
                    }
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  >
                    {roles
                      .filter(
                        (role) => role.key !== "owner" || canTransfer || role.id === member.role.id
                      )
                      .map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                  </select>
                ) : (
                  <span className="text-sm text-foreground">{member.role.name}</span>
                )}
                <Button
                  variant="outline"
                  disabled={
                    !canManage ||
                    pendingMemberIds.has(member.userId) ||
                    (member.role.key === "owner" &&
                      (!canTransfer ||
                        (member.suspendedAt === null && unsuspendedOwnerCount === 1)))
                  }
                  onClick={() =>
                    void mutate(member.userId, () =>
                      updateMember(member, {
                        kind: "status",
                        suspended: member.suspendedAt === null,
                      })
                    )
                  }
                >
                  {member.suspendedAt === null ? "Suspend" : "Restore"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {canReadRoles && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Roles
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {roles.map((role) => (
              <article key={role.id} className="rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="font-medium text-foreground">{role.name}</h4>
                  <span className="text-xs text-muted-foreground">
                    {role.assignmentCount} assigned
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {role.description ?? `${role.permissions.length} permissions`}
                </p>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
