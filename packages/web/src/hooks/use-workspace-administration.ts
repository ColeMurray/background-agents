"use client";

import useSWR, { useSWRConfig } from "swr";
import {
  roleListResponseSchema,
  workspaceMemberListResponseSchema,
  type RoleSummary,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useAuthSession } from "@/lib/auth-session";
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
    await Promise.all([
      members.mutate(),
      roles.mutate(),
      session?.user?.id
        ? mutate(currentUserAuthorizationKey(session.user.id), undefined, { revalidate: true })
        : Promise.resolve(undefined),
    ]);
  }

  return {
    members: members.data ?? [],
    roles: roles.data ?? [],
    loading: (input.readMembers && members.isLoading) || (input.readRoles && roles.isLoading),
    error: members.error ?? roles.error,
    updateMember,
  };
}
