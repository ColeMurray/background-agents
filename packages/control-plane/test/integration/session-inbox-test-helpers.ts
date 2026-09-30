import { env } from "cloudflare:test";
import type { SessionViewer } from "@open-inspect/shared";
import type { SessionEntry } from "../../src/db/session-index";

export const VIEWER_ID = "11111111111111111111111111111111";
export const viewer: SessionViewer = {
  kind: "user",
  userId: VIEWER_ID,
  roleKey: "member",
  permissions: ["sessions.read"],
  suspended: false,
  memberships: new Map([["team-a", "member"]]),
};

export async function seedTeams(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'Viewer', 1, 1)"
  )
    .bind(VIEWER_ID)
    .run();
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'a', 'A', 1, 1), ('team-b', 'b', 'B', 1, 1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO team_memberships (team_id, user_id, created_at) VALUES ('team-a', ?, 1)"
  )
    .bind(VIEWER_ID)
    .run();
}

export function session(id: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    ownerTeamId: null,
    visibility: "workspace",
    title: id,
    repoOwner: "open-inspect",
    repoName: "open-inspect",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "high",
    baseBranch: "main",
    status: "completed",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    userId: VIEWER_ID,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}
