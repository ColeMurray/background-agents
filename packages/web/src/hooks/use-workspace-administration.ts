"use client";

import useSWR, { useSWRConfig } from "swr";
import {
  roleListResponseSchema,
  workspaceMemberListResponseSchema,
  type EffectiveAuthorization,
  type RoleSummary,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { clearAuthSessionCache, useAuthSession } from "@/lib/auth-session";
import { currentUserAuthorizationKey } from "./use-current-user-authorization";

async function fetchMembers(): Promise<WorkspaceMember[]> {
  const response = await browserApiFetch("/api/members");
  if (!response.ok) throw new Error(`Members request failed (${response.status})`);
  return workspaceMemberListResponseSchema.parse(await response.json());
}

async function fetchRoles(): Promise<RoleSummary[]> {
  const response = await browserApiFetch("/api/roles");
  if (!response.ok) throw new Error(`Roles request failed (${response.status})`);
  return roleListResponseSchema.parse(await response.json());
}

/**
 * Provides the workspace members and roles the current user may read, plus authorized member updates.
 */
export function useWorkspaceAdministration(input: { readMembers: boolean; readRoles: boolean }) {
  const { mutate } = useSWRConfig();
  const { data: session } = useAuthSession();
  const members = useSWR(input.readMembers ? "/api/members" : null, fetchMembers);
  const roles = useSWR(input.readRoles ? "/api/roles" : null, fetchRoles);

  async function updateMember(
    user: WorkspaceMember,
    action: { kind: "role"; roleId: string } | { kind: "status"; suspended: boolean }
  ): Promise<void> {
    const path =
      action.kind === "role"
        ? (`/api/members/${encodeURIComponent(user.userId)}/role` as const)
        : (`/api/members/${encodeURIComponent(user.userId)}/status` as const);
    const body =
      action.kind === "role" ? { roleId: action.roleId } : { suspended: action.suspended };
    const response = await browserApiFetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Member update failed (${response.status})`);

    const nextRole =
      action.kind === "role" ? roles.data?.find(({ id }) => id === action.roleId) : null;
    try {
      await members.mutate(
        (current) =>
          current?.map((member) => {
            if (member.userId !== user.userId) return member;
            if (action.kind === "status") {
              return { ...member, suspendedAt: action.suspended ? Date.now() : null };
            }
            return nextRole ? { ...member, role: roleReference(nextRole) } : member;
          }),
        { revalidate: false }
      );

      if (action.kind === "role" && nextRole && nextRole.id !== user.role.id) {
        await roles.mutate(
          (current) =>
            current?.map((role) => ({
              ...role,
              assignmentCount:
                role.id === user.role.id
                  ? Math.max(0, role.assignmentCount - 1)
                  : role.id === nextRole.id
                    ? role.assignmentCount + 1
                    : role.assignmentCount,
            })),
          { revalidate: false }
        );
      }

      if (session?.user?.id === user.userId) {
        const authorizationKey = currentUserAuthorizationKey(user.userId);
        if (action.kind === "status" && action.suspended) {
          await Promise.all([
            clearAuthSessionCache(),
            mutate(authorizationKey, undefined, { revalidate: false }),
          ]);
        } else if (action.kind === "role" && nextRole) {
          await mutate<EffectiveAuthorization>(
            authorizationKey,
            (current) =>
              current
                ? {
                    ...current,
                    role: roleReference(nextRole),
                    permissions: nextRole.permissions,
                  }
                : current,
            { revalidate: false }
          );
        }
      }
    } catch {
      // The server mutation already committed. Cache maintenance must never
      // turn that success into a retryable-looking mutation failure.
    }
  }

  return {
    members: members.data ?? [],
    roles: roles.data ?? [],
    loading: (input.readMembers && members.isLoading) || (input.readRoles && roles.isLoading),
    error: members.error ?? roles.error,
    updateMember,
  };
}

function roleReference(role: RoleSummary): WorkspaceMember["role"] {
  return { id: role.id, key: role.key, name: role.name };
}
