/**
 * KV accessor helpers for config, issue sessions, and event deduplication.
 *
 * The `config:*` and `user_prefs:*` keys are operator-managed: edit them
 * directly with `wrangler kv key put --namespace-id <LINEAR_KV> <key> <json>`
 * (the HTTP /config endpoints were retired with the shared bearer):
 * - `config:team-repos`   — { [teamKey]: "owner/repo" }
 * - `config:project-repos` — { [projectId]: "owner/repo" }
 * - `user_prefs:<userId>`  — { userId, model, reasoningEffort?, updatedAt }
 */

import type {
  Env,
  TeamRepoMapping,
  ProjectRepoMapping,
  UserPreferences,
  IssueSession,
} from "./types";
import { createLogger } from "./logger";

const log = createLogger("kv-store");

export async function getTeamRepoMapping(env: Env): Promise<TeamRepoMapping> {
  try {
    const data = await env.LINEAR_KV.get("config:team-repos", "json");
    if (data && typeof data === "object") return data as TeamRepoMapping;
  } catch (e) {
    log.debug("kv.get_team_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getProjectRepoMapping(env: Env): Promise<ProjectRepoMapping> {
  try {
    const data = await env.LINEAR_KV.get("config:project-repos", "json");
    if (data && typeof data === "object") return data as ProjectRepoMapping;
  } catch (e) {
    log.debug("kv.get_project_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getUserPreferences(
  env: Env,
  userId: string
): Promise<UserPreferences | null> {
  try {
    const data = await env.LINEAR_KV.get(`user_prefs:${userId}`, "json");
    if (data && typeof data === "object") return data as UserPreferences;
  } catch (e) {
    log.debug("kv.get_user_preferences_failed", {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

function getIssueSessionKey(issueId: string): string {
  return `issue:${issueId}`;
}

export async function lookupIssueSession(env: Env, issueId: string): Promise<IssueSession | null> {
  try {
    const data = await env.LINEAR_KV.get(getIssueSessionKey(issueId), "json");
    if (data && typeof data === "object") return data as IssueSession;
  } catch (e) {
    log.debug("kv.lookup_issue_session_failed", {
      issueId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

export async function storeIssueSession(
  env: Env,
  issueId: string,
  session: IssueSession
): Promise<void> {
  await env.LINEAR_KV.put(getIssueSessionKey(issueId), JSON.stringify(session), {
    expirationTtl: 86400 * 7,
  });
}

/**
 * Check if an event has already been processed (deduplication).
 */
export async function isDuplicateEvent(env: Env, eventKey: string): Promise<boolean> {
  const existing = await env.LINEAR_KV.get(`event:${eventKey}`);
  if (existing) return true;
  await env.LINEAR_KV.put(`event:${eventKey}`, "1", { expirationTtl: 3600 });
  return false;
}
