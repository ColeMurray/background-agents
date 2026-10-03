"use client";

import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import type {
  createTeamRequestSchema,
  updateTeamRequestSchema,
} from "@open-inspect/shared/types/teams";
import {
  teamMemberSchema,
  teamResponseSchema,
  teamRoleSchema,
  meTeamsResponseSchema,
  type TeamRole,
} from "@open-inspect/shared/types/teams";
import { workspaceMemberListResponseSchema } from "@open-inspect/shared/rbac";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { useAuthSession } from "@/lib/auth-session";
import { ME_TEAMS_API_PATH, meTeamsKey } from "@/lib/me-teams-cache";
import { fetchTeamSnapshot, teamSnapshot, type TeamSnapshot } from "@/lib/team-snapshot";

export { isRetryableTeamError, teamSnapshot, type TeamSnapshot } from "@/lib/team-snapshot";

export const TEAMS_KEY = "/api/teams";
export function teamCacheKey(path: BrowserApiPath, userId: string | undefined) {
  return userId ? ([path, userId] as const) : null;
}
// Missing or incomplete capabilities leave the team visible while every team action stays disabled.
const teamSchema = teamResponseSchema.extend({
  capabilities: teamResponseSchema.shape.capabilities.partial().optional(),
});
export type TeamResponse = z.infer<typeof teamSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
const teamsSchema = z.object({ teams: z.array(teamSchema) });
const meTeamsSchema = meTeamsResponseSchema.extend({
  teams: z.array(teamSchema.extend({ role: teamRoleSchema })),
});
const membersSchema = z.object({ members: z.array(teamMemberSchema) });

export function reconcileTeamDirectory(
  current: TeamSnapshot<z.infer<typeof teamsSchema>> | undefined,
  team: TeamResponse
) {
  return current?.kind === "ready"
    ? teamSnapshot({
        teams: [...current.value.teams.filter((existing) => existing.id !== team.id), team],
      })
    : current;
}

async function get<T>(path: BrowserApiPath, schema: z.ZodType<T>): Promise<T> {
  const snapshot = await fetchTeamSnapshot(path, schema);
  if (snapshot.kind === "denied") throw snapshot.error;
  return snapshot.value;
}

function useTeamSnapshot<T>(
  key: ReturnType<typeof teamCacheKey>,
  path: BrowserApiPath,
  schema: z.ZodType<T>
) {
  const result = useSWR<TeamSnapshot<T>>(key, () => fetchTeamSnapshot(path, schema), {
    keepPreviousData: false,
  });
  return {
    data: result.data?.kind === "ready" ? result.data.value : undefined,
    error: result.data?.kind === "denied" ? result.data.error : result.error,
    isLoading: result.isLoading,
  };
}

function write(path: BrowserApiPath, method: string, body?: object): Promise<void>;
function write<T>(
  path: BrowserApiPath,
  method: string,
  body: object | undefined,
  schema: z.ZodType<T>
): Promise<T>;
async function write<T>(
  path: BrowserApiPath,
  method: string,
  body?: object,
  schema?: z.ZodType<T>
): Promise<T | void> {
  const response = await browserApiFetch(path, {
    method,
    ...(body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const message =
      typeof failure?.error === "string"
        ? failure.error
        : `Team request failed (${response.status})`;
    throw new Error(typeof failure?.code === "string" ? `${message} (${failure.code})` : message);
  }
  if (!schema) return;
  return schema.parse(await response.json());
}

export function useMeTeams(enabled = true) {
  const { data: session } = useAuthSession();
  const userId = session?.user.id;
  const result = useTeamSnapshot(
    userId && enabled ? meTeamsKey(userId) : null,
    ME_TEAMS_API_PATH,
    meTeamsSchema
  );
  return {
    teams: result.data?.teams ?? [],
    canListAllTeams: result.data?.capabilities.canListAllTeams ?? false,
    requireTeamOnCreate: result.data?.requireTeamOnCreate ?? false,
    loading: enabled && Boolean(userId) && !result.data && !result.error,
    error: result.error,
    hasData: result.data !== undefined,
  };
}

export function useTeams(enabled = true) {
  const { data: session } = useAuthSession();
  const userId = session?.user.id;
  const { mutate } = useSWRConfig();
  const key = teamCacheKey(TEAMS_KEY, userId);
  const result = useTeamSnapshot(enabled ? key : null, TEAMS_KEY, teamsSchema);

  async function createTeam(input: z.input<typeof createTeamRequestSchema>) {
    const team = await write(TEAMS_KEY, "POST", input, teamSchema);
    await Promise.allSettled([
      mutate(
        key,
        (current: TeamSnapshot<z.infer<typeof teamsSchema>> | undefined) =>
          reconcileTeamDirectory(current, team),
        { revalidate: (data) => data?.kind !== "ready" }
      ),
      mutate(userId ? meTeamsKey(userId) : null),
    ]);
    return team;
  }

  async function joinTeam(id: string) {
    const path = `/api/teams/${encodeURIComponent(id)}` as const;
    const team = await write(`${path}/join`, "POST", undefined, teamSchema);
    await Promise.allSettled([
      mutate(teamCacheKey(path, userId), teamSnapshot(team), { revalidate: false }),
      mutate(key),
      mutate(userId ? meTeamsKey(userId) : null),
      mutate(teamCacheKey(`${path}/members`, userId)),
    ]);
    return team;
  }

  return {
    teams: result.data?.teams ?? [],
    loading: result.isLoading,
    error: result.error,
    createTeam,
    joinTeam,
  };
}

export function useTeam(id: string) {
  const { data: session } = useAuthSession();
  const userId = session?.user.id;
  const { mutate } = useSWRConfig();
  const path = `/api/teams/${encodeURIComponent(id)}` as const;
  const key = teamCacheKey(path, userId);
  const result = useTeamSnapshot(key, path, teamSchema);

  async function updateTeam(input: z.input<typeof updateTeamRequestSchema>) {
    const team = await write(path, "PATCH", input, teamSchema);
    await Promise.allSettled([
      mutate(key, teamSnapshot(team), { revalidate: false }),
      mutate(
        teamCacheKey(TEAMS_KEY, userId),
        (current: TeamSnapshot<z.infer<typeof teamsSchema>> | undefined) =>
          reconcileTeamDirectory(current, team),
        { revalidate: (data) => data === undefined }
      ),
      mutate(userId ? meTeamsKey(userId) : null),
    ]);
    return team;
  }
  async function changeArchive(archive: boolean) {
    const team = await write(
      `${path}/${archive ? "archive" : "restore"}`,
      "POST",
      undefined,
      teamSchema
    );
    await Promise.allSettled([
      mutate(key, teamSnapshot(team), { revalidate: false }),
      mutate(teamCacheKey(TEAMS_KEY, userId)),
      mutate(userId ? meTeamsKey(userId) : null),
    ]);
    return team;
  }
  return {
    team: result.data,
    loading: result.isLoading,
    error: result.error,
    updateTeam,
    changeArchive,
  };
}

export function useTeamMembers(id: string) {
  const { data: session } = useAuthSession();
  const viewerId = session?.user.id;
  const { mutate } = useSWRConfig();
  const path = `/api/teams/${encodeURIComponent(id)}/members` as const;
  const key = teamCacheKey(path, viewerId);
  const result = useSWR(key, () => get(path, membersSchema), { keepPreviousData: false });

  async function setMember(userId: string, role: TeamRole) {
    const { member } = await write(
      `${path}/${encodeURIComponent(userId)}`,
      "PUT",
      { role },
      z.object({ member: teamMemberSchema })
    );
    await Promise.allSettled([
      mutate(
        key,
        (current: z.infer<typeof membersSchema> | undefined) => ({
          members: [
            ...(current?.members ?? []).filter((existing) => existing.userId !== userId),
            member,
          ],
        }),
        { revalidate: false }
      ),
      mutate(teamCacheKey(`/api/teams/${encodeURIComponent(id)}`, viewerId)),
      mutate(teamCacheKey(TEAMS_KEY, viewerId)),
      mutate(viewerId ? meTeamsKey(viewerId) : null),
    ]);
  }
  async function removeMember(userId: string) {
    await write(`${path}/${encodeURIComponent(userId)}`, "DELETE");
    await Promise.allSettled([
      mutate(
        key,
        (current: z.infer<typeof membersSchema> | undefined) =>
          current
            ? { members: current.members.filter((member) => member.userId !== userId) }
            : current,
        { revalidate: false }
      ),
      mutate(teamCacheKey(`/api/teams/${encodeURIComponent(id)}`, viewerId)),
      mutate(teamCacheKey(TEAMS_KEY, viewerId)),
      mutate(viewerId ? meTeamsKey(viewerId) : null),
    ]);
  }
  return {
    members: result.data?.members ?? [],
    loading: result.isLoading,
    error: result.error,
    setMember,
    removeMember,
  };
}

export function useTeamMemberCandidates(enabled: boolean) {
  const result = useSWR(enabled ? "/api/members" : null, () =>
    get("/api/members", workspaceMemberListResponseSchema)
  );
  return { candidates: result.data ?? [], loading: result.isLoading, error: result.error };
}
