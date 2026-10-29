import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { ME_TEAMS_API_PATH } from "@/lib/me-teams-cache";

export const viewerSession = {
  data: { user: { id: "user_one", name: "Ada" } },
  status: "authenticated" as const,
};

export const membership = {
  id: "team_design",
  slug: "design",
  name: "Design",
  description: null,
  joinPolicy: "invite_only" as const,
  defaultVisibility: "team" as const,
  defaultEnvironmentId: null,
  grantsVersion: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  memberCount: 1,
  role: "member" as const,
};

export const readableTeam = {
  ...membership,
  capabilities: {
    canReadTeamSessions: true,
    canReadTeamRepositories: false,
    canReadTeamEnvironments: true,
    canReadAutomations: true,
    canJoin: false,
    canLeave: false,
    canEditMetadata: false,
    canManageMembers: false,
    canManageRepositories: false,
    canManageBindings: false,
    canManageAutomations: false,
    canManageEnvironments: false,
    canManageSecrets: false,
    canArchive: false,
  },
};

export const member = {
  teamId: membership.id,
  userId: "user_one",
  role: "member" as const,
  source: "manual" as const,
  createdAt: 1,
  displayName: "Ada",
  email: null,
  avatarUrl: null,
};

export const detailPath = "/api/teams/team_design";

export function teamApiResponse(path: string) {
  if (path === ME_TEAMS_API_PATH)
    return Response.json({
      teams: [readableTeam],
      requireTeamOnCreate: true,
      capabilities: { canListAllTeams: true },
    });
  if (path.endsWith("/members")) return Response.json({ members: [member] });
  return Response.json(path === "/api/teams" ? { teams: [readableTeam] } : readableTeam);
}

export function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
        keepPreviousData: true,
      }}
    >
      {children}
    </SWRConfig>
  );
}
