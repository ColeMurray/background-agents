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
  type TeamRole,
} from "@open-inspect/shared/types/teams";
import { workspaceMemberListResponseSchema } from "@open-inspect/shared/rbac";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { useAuthSession } from "@/lib/auth-session";

const TEAMS_KEY = "/api/teams";
const ME_TEAMS_KEY = "/api/me/teams";
// Older or incomplete responses remain readable, but cannot authorize controls.
const teamSchema = teamResponseSchema.extend({
  capabilities: teamResponseSchema.shape.capabilities.optional(),
});
export type TeamResponse = z.infer<typeof teamSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
const teamsSchema = z.object({ teams: z.array(teamSchema) });
const meTeamsSchema = z.object({ teams: z.array(teamSchema.extend({ role: teamRoleSchema })) });
const membersSchema = z.object({ members: z.array(teamMemberSchema) });

async function get<T>(path: BrowserApiPath, schema: z.ZodType<T>): Promise<T> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error(`Failed to load teams (${response.status})`);
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

export function useMeTeams() {
  const { data: session } = useAuthSession();
  const result = useSWR(session?.user ? ME_TEAMS_KEY : null, () =>
    get(ME_TEAMS_KEY, meTeamsSchema)
  );
  return { teams: result.data?.teams ?? [], loading: result.isLoading, error: result.error };
}

export function useTeams(allTeams: boolean) {
  const { data: session } = useAuthSession();
  const { mutate } = useSWRConfig();
  const result = useSWR(session?.user ? (allTeams ? TEAMS_KEY : ME_TEAMS_KEY) : null, () =>
    allTeams ? get(TEAMS_KEY, teamsSchema) : get(ME_TEAMS_KEY, meTeamsSchema)
  );

  async function createTeam(input: z.input<typeof createTeamRequestSchema>) {
    const team = await write(TEAMS_KEY, "POST", input, teamSchema);
    await Promise.all([mutate(TEAMS_KEY), mutate(ME_TEAMS_KEY)]);
    return team;
  }

  return {
    teams: result.data?.teams ?? [],
    loading: result.isLoading,
    error: result.error,
    createTeam,
  };
}

export function useTeam(id: string) {
  const { data: session } = useAuthSession();
  const { mutate } = useSWRConfig();
  const key = `/api/teams/${encodeURIComponent(id)}` as const;
  const result = useSWR(session?.user ? key : null, () => get(key, teamSchema));

  async function refresh() {
    await Promise.all([mutate(key), mutate(TEAMS_KEY), mutate(ME_TEAMS_KEY)]);
  }
  async function updateTeam(input: z.input<typeof updateTeamRequestSchema>) {
    const team = await write(key, "PATCH", input, teamSchema);
    await refresh();
    return team;
  }
  async function changeArchive(archive: boolean) {
    const team = await write(
      `${key}/${archive ? "archive" : "restore"}`,
      "POST",
      undefined,
      teamSchema
    );
    await refresh();
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

  async function refresh() {
    await Promise.all([
      mutate(key),
      mutate(`/api/teams/${encodeURIComponent(id)}`),
      mutate(TEAMS_KEY),
      mutate(ME_TEAMS_KEY),
    ]);
  }
  async function setMember(userId: string, role: TeamRole) {
    await write(`${key}/${encodeURIComponent(userId)}`, "PUT", { role });
    await refresh();
  }
  async function removeMember(userId: string) {
    await write(`${key}/${encodeURIComponent(userId)}`, "DELETE");
    await refresh();
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
