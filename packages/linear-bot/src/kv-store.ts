/**
 * KV accessor helpers for config, issue sessions, and event deduplication.
 */

import type {
  Env,
  TriggerConfig,
  TeamRepoMapping,
  ProjectRepoMapping,
  UserPreferences,
  IssueSession,
  LinearAuthNotificationFailureReason,
  LinearAuthNotificationOutcome,
  LinearAuthNotificationState,
  LinearWorkspaceAuthState,
  LinearWorkspaceAuthStatus,
  OAuthStateRecord,
} from "./types";
import { createLogger } from "./logger";

const log = createLogger("kv-store");
const LINEAR_AUTH_KEY_PREFIX = "linear_auth:";
const OAUTH_STATE_KEY_PREFIX = "oauth:state:";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  triggerLabel: "agent",
  autoTriggerOnCreate: false,
  triggerCommand: "@agent",
};

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

export async function getTriggerConfig(env: Env): Promise<TriggerConfig> {
  try {
    const data = await env.LINEAR_KV.get("config:triggers", "json");
    if (data && typeof data === "object") {
      return { ...DEFAULT_TRIGGER_CONFIG, ...(data as Partial<TriggerConfig>) };
    }
  } catch (e) {
    log.debug("kv.get_trigger_config_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return DEFAULT_TRIGGER_CONFIG;
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

// ─── Linear Workspace Auth Health ───────────────────────────────────────────

function getLinearAuthStateKey(orgId: string): string {
  return `${LINEAR_AUTH_KEY_PREFIX}${orgId}`;
}

function isLinearWorkspaceAuthStatus(value: unknown): value is LinearWorkspaceAuthStatus {
  return (
    value === "connected" || value === "reauthorization_required" || value === "transient_failure"
  );
}

function isLinearWorkspaceAuthState(
  value: unknown,
  orgId: string
): value is LinearWorkspaceAuthState {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LinearWorkspaceAuthState>;
  return (
    record.schemaVersion === 1 &&
    record.orgId === orgId &&
    isLinearWorkspaceAuthStatus(record.status)
  );
}

export async function getLinearAuthState(
  env: Env,
  orgId: string
): Promise<LinearWorkspaceAuthState | null> {
  try {
    const data = await env.LINEAR_KV.get(getLinearAuthStateKey(orgId), "json");
    if (isLinearWorkspaceAuthState(data, orgId)) return data;
  } catch (e) {
    log.debug("kv.get_linear_auth_state_failed", {
      org_id: orgId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

export async function setLinearAuthState(
  env: Env,
  params: {
    orgId: string;
    status: LinearWorkspaceAuthStatus;
    reason: string;
    traceId?: string;
    details?: LinearWorkspaceAuthState["details"];
    installation?: LinearWorkspaceAuthState["installation"];
  }
): Promise<LinearWorkspaceAuthState> {
  const now = Date.now();
  const existing = await getLinearAuthState(env, params.orgId);
  const existingInstallation = existing?.installation;
  const installation =
    params.installation || existingInstallation
      ? {
          ...existingInstallation,
          ...params.installation,
          ...(params.status === "connected"
            ? {
                connectedAt: existingInstallation?.connectedAt ?? now,
                lastConnectedAt: now,
              }
            : {}),
        }
      : undefined;
  const state: LinearWorkspaceAuthState = {
    schemaVersion: 1,
    orgId: params.orgId,
    status: params.status,
    reason: params.reason,
    updatedAt: now,
    ...(params.traceId ? { lastTraceId: params.traceId } : {}),
    ...(params.details ? { details: params.details } : {}),
    ...(installation ? { installation } : {}),
    ...(params.status !== "connected" && existing?.lastNotification
      ? { lastNotification: existing.lastNotification }
      : {}),
  };
  await env.LINEAR_KV.put(getLinearAuthStateKey(params.orgId), JSON.stringify(state));
  return state;
}

export function buildLinearAuthNotificationFingerprint(params: {
  orgId: string;
  issueId: string;
  status: LinearWorkspaceAuthStatus;
  reason: string;
}): string {
  return `auth_failure:v1:${params.orgId}:${params.issueId}:${params.status}:${params.reason}`;
}

async function putLinearAuthNotification(
  env: Env,
  orgId: string,
  notification: LinearAuthNotificationState
): Promise<void> {
  const existing = await getLinearAuthState(env, orgId);
  const state: LinearWorkspaceAuthState = {
    schemaVersion: 1,
    orgId,
    status: existing?.status ?? "reauthorization_required",
    reason: existing?.reason ?? "notification_recorded",
    updatedAt: existing?.updatedAt ?? Date.now(),
    ...(existing?.lastTraceId ? { lastTraceId: existing.lastTraceId } : {}),
    ...(existing?.details ? { details: existing.details } : {}),
    ...(existing?.installation ? { installation: existing.installation } : {}),
    lastNotification: notification,
  };
  await env.LINEAR_KV.put(getLinearAuthStateKey(orgId), JSON.stringify(state));
}

export async function beginLinearAuthNotification(
  env: Env,
  params: {
    orgId: string;
    fingerprint: string;
    issueId?: string;
    issueIdentifier?: string;
    agentSessionId?: string;
    traceId?: string;
  }
): Promise<{ suppressed: boolean }> {
  const existing = await getLinearAuthState(env, params.orgId);
  const previous = existing?.lastNotification;
  const now = Date.now();
  if (
    previous?.fingerprint === params.fingerprint &&
    (previous.outcome === "attempting" || previous.outcome === "sent")
  ) {
    await putLinearAuthNotification(env, params.orgId, {
      ...previous,
      lastSuppressedAt: now,
      suppressedCount: (previous.suppressedCount ?? 0) + 1,
      traceId: params.traceId ?? previous.traceId,
    });
    return { suppressed: true };
  }

  await putLinearAuthNotification(env, params.orgId, {
    fingerprint: params.fingerprint,
    issueId: params.issueId,
    issueIdentifier: params.issueIdentifier,
    agentSessionId: params.agentSessionId,
    delivery: "comment_fallback",
    outcome: "attempting",
    traceId: params.traceId,
    attemptedAt: now,
  });
  return { suppressed: false };
}

export async function completeLinearAuthNotification(
  env: Env,
  params: {
    orgId: string;
    fingerprint: string;
    outcome: Exclude<LinearAuthNotificationOutcome, "attempting">;
    failureReason?: LinearAuthNotificationFailureReason;
    httpStatus?: number;
  }
): Promise<void> {
  const existing = await getLinearAuthState(env, params.orgId);
  const previous = existing?.lastNotification;
  const now = Date.now();
  await putLinearAuthNotification(env, params.orgId, {
    fingerprint: params.fingerprint,
    issueId: previous?.issueId,
    issueIdentifier: previous?.issueIdentifier,
    agentSessionId: previous?.agentSessionId,
    delivery: "comment_fallback",
    outcome: params.outcome,
    failureReason: params.failureReason,
    traceId: previous?.traceId,
    attemptedAt: previous?.attemptedAt ?? now,
    completedAt: now,
    suppressedCount: previous?.suppressedCount,
    lastSuppressedAt: previous?.lastSuppressedAt,
    httpStatus: params.httpStatus,
  });
}

// ─── OAuth State ────────────────────────────────────────────────────────────

export async function storeOAuthState(env: Env, state: string): Promise<void> {
  const record: OAuthStateRecord = { state, createdAt: Date.now() };
  await env.LINEAR_KV.put(`${OAUTH_STATE_KEY_PREFIX}${state}`, JSON.stringify(record), {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });
}

export async function consumeOAuthState(env: Env, state: string): Promise<boolean> {
  try {
    const key = `${OAUTH_STATE_KEY_PREFIX}${state}`;
    const record = await env.LINEAR_KV.get(key, "json");
    if (!record || typeof record !== "object" || (record as OAuthStateRecord).state !== state) {
      return false;
    }
    await env.LINEAR_KV.delete(key);
    return true;
  } catch (e) {
    log.debug("kv.consume_oauth_state_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
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
