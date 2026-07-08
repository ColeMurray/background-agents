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
  LinearAuthHealthResponse,
  LinearWorkspaceAuthState,
  LinearWorkspaceAuthStatus,
} from "./types";
import { createLogger } from "./logger";
import { timingSafeEqual } from "@open-inspect/shared";
import { computeHmacHex } from "./utils/crypto";

const log = createLogger("kv-store");
const LINEAR_AUTH_KEY_PREFIX = "linear_auth:";
const SECOND_MS = 1000;
const ISSUE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * SECOND_MS;
const EVENT_DEDUP_TTL_MS = 60 * 60 * SECOND_MS;
export const OAUTH_STATE_TTL_MS = 10 * 60 * SECOND_MS;
const OAUTH_STATE_SCOPE = "linear_oauth_state";
const OAUTH_STATE_TOKEN_PREFIX = "linear_oauth_state_v1";

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  triggerLabel: "agent",
  autoTriggerOnCreate: false,
  triggerCommand: "@agent",
};

function expirationTtlSeconds(ttlMs: number): number {
  return Math.ceil(ttlMs / SECOND_MS);
}

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
    expirationTtl: expirationTtlSeconds(ISSUE_SESSION_TTL_MS),
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
          ...(params.status === "connected" && params.reason === "oauth_callback"
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
  };
  await env.LINEAR_KV.put(getLinearAuthStateKey(params.orgId), JSON.stringify(state));
  return state;
}

function authStateRank(status: LinearWorkspaceAuthStatus): number {
  if (status === "reauthorization_required") return 3;
  if (status === "transient_failure") return 2;
  return 1;
}

function chooseMostActionableAuthState(
  states: LinearWorkspaceAuthState[]
): LinearWorkspaceAuthState | null {
  let selected: LinearWorkspaceAuthState | null = null;
  for (const state of states) {
    if (!selected) {
      selected = state;
      continue;
    }

    const stateRank = authStateRank(state.status);
    const selectedRank = authStateRank(selected.status);
    if (
      stateRank > selectedRank ||
      (stateRank === selectedRank && state.updatedAt > selected.updatedAt)
    ) {
      selected = state;
    }
  }
  return selected;
}

async function listLinearAuthStateKeys(env: Env): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await env.LINEAR_KV.list({ prefix: LINEAR_AUTH_KEY_PREFIX, cursor });
    names.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return names;
}

async function readLinearAuthStateForHealth(
  env: Env,
  keyName: string
): Promise<LinearWorkspaceAuthState | null> {
  const orgId = keyName.slice(LINEAR_AUTH_KEY_PREFIX.length);
  const raw = await env.LINEAR_KV.get(keyName);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isLinearWorkspaceAuthState(parsed, orgId) ? parsed : null;
}

export async function getLinearAuthHealthResponse(
  env: Env,
  reconnectUrl: string
): Promise<LinearAuthHealthResponse> {
  try {
    const keyNames = await listLinearAuthStateKeys(env);
    const states = await Promise.all(
      keyNames.map((keyName) => readLinearAuthStateForHealth(env, keyName))
    );
    const selected = chooseMostActionableAuthState(
      states.filter((state): state is LinearWorkspaceAuthState => state !== null)
    );

    if (!selected) {
      return { status: "unknown", reconnectUrl };
    }

    return {
      status: selected.status,
      reconnectUrl,
      orgId: selected.orgId,
      orgName: selected.installation?.orgName,
      reason: selected.reason,
      updatedAt: selected.updatedAt,
      lastTraceId: selected.lastTraceId,
    };
  } catch (e) {
    log.warn("kv.get_linear_auth_health_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { status: "unavailable", reason: "auth_health_unavailable", reconnectUrl };
  }
}

// ─── OAuth State ────────────────────────────────────────────────────────────

interface SignedOAuthStatePayload {
  scope: typeof OAUTH_STATE_SCOPE;
  nonce: string;
  clientId: string;
  issuedAt: number;
  expiresAt: number;
}

function isSignedOAuthStatePayload(
  value: unknown,
  env: Env,
  now: number
): value is SignedOAuthStatePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<SignedOAuthStatePayload>;
  return (
    payload.scope === OAUTH_STATE_SCOPE &&
    typeof payload.nonce === "string" &&
    payload.nonce.length > 0 &&
    payload.clientId === env.LINEAR_CLIENT_ID &&
    typeof payload.issuedAt === "number" &&
    Number.isFinite(payload.issuedAt) &&
    typeof payload.expiresAt === "number" &&
    Number.isFinite(payload.expiresAt) &&
    payload.issuedAt <= now &&
    payload.expiresAt > now
  );
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function getOAuthStateSigningInput(encodedPayload: string): string {
  return `${OAUTH_STATE_TOKEN_PREFIX}.${encodedPayload}`;
}

export async function storeOAuthState(env: Env, state: string): Promise<string> {
  const now = Date.now();
  const payload: SignedOAuthStatePayload = {
    scope: OAUTH_STATE_SCOPE,
    nonce: state,
    clientId: env.LINEAR_CLIENT_ID,
    issuedAt: now,
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = getOAuthStateSigningInput(encodedPayload);
  const signature = await computeHmacHex(signingInput, env.LINEAR_CLIENT_SECRET);
  return `${signingInput}.${signature}`;
}

export async function consumeOAuthState(env: Env, state: string): Promise<boolean> {
  try {
    const parts = state.split(".");
    if (parts.length !== 3 || parts[0] !== OAUTH_STATE_TOKEN_PREFIX) return false;
    const [, encodedPayload, signature] = parts;
    const signingInput = getOAuthStateSigningInput(encodedPayload);
    const expectedSignature = await computeHmacHex(signingInput, env.LINEAR_CLIENT_SECRET);
    if (!timingSafeEqual(signature, expectedSignature)) return false;

    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as unknown;
    if (!isSignedOAuthStatePayload(payload, env, Date.now())) return false;
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
  await env.LINEAR_KV.put(`event:${eventKey}`, "1", {
    expirationTtl: expirationTtlSeconds(EVENT_DEDUP_TTL_MS),
  });
  return false;
}
