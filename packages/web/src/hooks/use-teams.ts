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
import { ME_TEAMS_API_PATH, isMeTeamsCacheKey, meTeamsKey } from "@/lib/me-teams-cache";

const TEAMS_KEY = "/api/teams";
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

class TeamRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "TeamRequestError";
  }
}

export function isRetryableTeamError(error: unknown): boolean {
  return error instanceof TeamRequestError && error.retryable;
}

async function get<T>(path: BrowserApiPath, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await browserApiFetch(path);
  } catch (cause) {
    throw new TeamRequestError(`Failed to load teams (${String(cause)})`, true);
  }
  if (!response.ok)
    throw new TeamRequestError(`Failed to load teams (${response.status})`, response.status >= 500);
  return schema.parse(await response.json());
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
  const result = useSWR(
    userId && enabled ? meTeamsKey(userId) : null,
    () => get(ME_TEAMS_API_PATH, meTeamsSchema),
    { keepPreviousData: false }
  );
  return {
    teams: result.data?.teams ?? [],
    requireTeamOnCreate: result.data?.requireTeamOnCreate ?? false,
    loading: enabled && Boolean(userId) && !result.data && !result.error,
    error: result.error,
    hasData: result.data !== undefined,
  };
}

export function useTeams(enabled = true) {
  const { data: session } = useAuthSession();
  const { mutate } = useSWRConfig();
  const result = useSWR(session?.user && enabled ? TEAMS_KEY : null, () =>
    get(TEAMS_KEY, teamsSchema)
  );

  async function createTeam(input: z.input<typeof createTeamRequestSchema>) {
    const team = await write(TEAMS_KEY, "POST", input, teamSchema);
    await Promise.allSettled([
      mutate(
        TEAMS_KEY,
        (current: z.infer<typeof teamsSchema> | undefined) => ({
          teams: [...(current?.teams ?? []).filter((existing) => existing.id !== team.id), team],
        }),
        { revalidate: false }
      ),
      mutate(isMeTeamsCacheKey),
    ]);
    return team;
  }

  async function joinTeam(id: string) {
    const key = `/api/teams/${encodeURIComponent(id)}` as const;
    const team = await write(`${key}/join`, "POST", undefined, teamSchema);
    await Promise.allSettled([
      mutate(key, team, { revalidate: false }),
      mutate(TEAMS_KEY),
      mutate(isMeTeamsCacheKey),
      mutate(`${key}/members`),
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
  const { mutate } = useSWRConfig();
  const key = `/api/teams/${encodeURIComponent(id)}` as const;
  const result = useSWR(session?.user ? key : null, () => get(key, teamSchema));

  async function updateTeam(input: z.input<typeof updateTeamRequestSchema>) {
    const team = await write(key, "PATCH", input, teamSchema);
    await Promise.allSettled([
      mutate(key, team, { revalidate: false }),
      mutate(
        TEAMS_KEY,
        (current: z.infer<typeof teamsSchema> | undefined) => ({
          teams: [...(current?.teams ?? []).filter((existing) => existing.id !== team.id), team],
        }),
        { revalidate: false }
      ),
      mutate(isMeTeamsCacheKey),
    ]);
    return team;
  }
  async function changeArchive(archive: boolean) {
    const team = await write(
      `${key}/${archive ? "archive" : "restore"}`,
      "POST",
      undefined,
      teamSchema
    );
    await Promise.allSettled([
      mutate(key, team, { revalidate: false }),
      mutate(TEAMS_KEY),
      mutate(isMeTeamsCacheKey),
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
  const { mutate } = useSWRConfig();
  const key = `/api/teams/${encodeURIComponent(id)}/members` as const;
  const result = useSWR(session?.user ? key : null, () => get(key, membersSchema));

  async function setMember(userId: string, role: TeamRole) {
    const { member } = await write(
      `${key}/${encodeURIComponent(userId)}`,
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
      mutate(`/api/teams/${encodeURIComponent(id)}`),
      mutate(TEAMS_KEY),
      mutate(isMeTeamsCacheKey),
    ]);
  }
  async function removeMember(userId: string) {
    await write(`${key}/${encodeURIComponent(userId)}`, "DELETE");
    await Promise.allSettled([
      mutate(
        key,
        (current: z.infer<typeof membersSchema> | undefined) =>
          current
            ? { members: current.members.filter((member) => member.userId !== userId) }
            : current,
        { revalidate: false }
      ),
      mutate(`/api/teams/${encodeURIComponent(id)}`),
      mutate(TEAMS_KEY),
      mutate(isMeTeamsCacheKey),
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
