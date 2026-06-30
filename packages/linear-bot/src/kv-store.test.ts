import { describe, expect, it } from "vitest";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getTriggerConfig,
  getUserPreferences,
  lookupIssueSession,
  storeIssueSession,
  isDuplicateEvent,
  DEFAULT_TRIGGER_CONFIG,
  beginLinearAuthNotification,
  buildLinearAuthNotificationFingerprint,
  completeLinearAuthNotification,
  consumeOAuthState,
  getLinearAuthState,
  setLinearAuthState,
  storeOAuthState,
} from "./kv-store";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

const errorKv = {
  async get() {
    throw new Error("KV error");
  },
} as unknown as KVNamespace;

// ─── getTeamRepoMapping ──────────────────────────────────────────────────────

describe("getTeamRepoMapping", () => {
  it("returns {} when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await getTeamRepoMapping(makeLinearBotEnv(kv))).toEqual({});
  });

  it("returns parsed mapping from KV", async () => {
    const mapping = { "team-1": [{ owner: "org", name: "repo" }] };
    const { kv } = createFakeKV({ "config:team-repos": JSON.stringify(mapping) });
    expect(await getTeamRepoMapping(makeLinearBotEnv(kv))).toEqual(mapping);
  });

  it("returns {} when KV throws", async () => {
    expect(await getTeamRepoMapping(makeLinearBotEnv(errorKv))).toEqual({});
  });
});

// ─── getProjectRepoMapping ───────────────────────────────────────────────────

describe("getProjectRepoMapping", () => {
  it("returns {} when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await getProjectRepoMapping(makeLinearBotEnv(kv))).toEqual({});
  });

  it("returns parsed mapping from KV", async () => {
    const mapping = { "proj-1": { owner: "org", name: "repo" } };
    const { kv } = createFakeKV({ "config:project-repos": JSON.stringify(mapping) });
    expect(await getProjectRepoMapping(makeLinearBotEnv(kv))).toEqual(mapping);
  });

  it("returns {} when KV throws", async () => {
    expect(await getProjectRepoMapping(makeLinearBotEnv(errorKv))).toEqual({});
  });
});

// ─── getTriggerConfig ────────────────────────────────────────────────────────

describe("getTriggerConfig", () => {
  it("returns defaults when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await getTriggerConfig(makeLinearBotEnv(kv))).toEqual(DEFAULT_TRIGGER_CONFIG);
  });

  it("merges partial config with defaults", async () => {
    const partial = { autoTriggerOnCreate: true };
    const { kv } = createFakeKV({ "config:triggers": JSON.stringify(partial) });
    expect(await getTriggerConfig(makeLinearBotEnv(kv))).toEqual({
      ...DEFAULT_TRIGGER_CONFIG,
      autoTriggerOnCreate: true,
    });
  });

  it("returns full override when all fields set", async () => {
    const full = {
      triggerLabel: "bot",
      autoTriggerOnCreate: true,
      triggerCommand: "@bot",
    };
    const { kv } = createFakeKV({ "config:triggers": JSON.stringify(full) });
    expect(await getTriggerConfig(makeLinearBotEnv(kv))).toEqual(full);
  });

  it("returns defaults when KV throws", async () => {
    expect(await getTriggerConfig(makeLinearBotEnv(errorKv))).toEqual(DEFAULT_TRIGGER_CONFIG);
  });
});

// ─── getUserPreferences ──────────────────────────────────────────────────────

describe("getUserPreferences", () => {
  it("returns null when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await getUserPreferences(makeLinearBotEnv(kv), "user-1")).toBeNull();
  });

  it("returns parsed preferences", async () => {
    const prefs = { userId: "user-1", model: "claude-opus-4-5", updatedAt: 123 };
    const { kv } = createFakeKV({ "user_prefs:user-1": JSON.stringify(prefs) });
    expect(await getUserPreferences(makeLinearBotEnv(kv), "user-1")).toEqual(prefs);
  });

  it("returns null when KV throws", async () => {
    expect(await getUserPreferences(makeLinearBotEnv(errorKv), "user-1")).toBeNull();
  });
});

// ─── lookupIssueSession ─────────────────────────────────────────────────────

describe("lookupIssueSession", () => {
  it("returns null when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await lookupIssueSession(makeLinearBotEnv(kv), "issue-1")).toBeNull();
  });

  it("returns session stored at issue:{id}", async () => {
    const session = {
      sessionId: "sess-1",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      repoOwner: "org",
      repoName: "repo",
      model: "claude-sonnet-4-5",
      createdAt: 123,
    };
    const { kv } = createFakeKV({ "issue:issue-1": JSON.stringify(session) });
    expect(await lookupIssueSession(makeLinearBotEnv(kv), "issue-1")).toEqual(session);
  });

  it("returns null when KV throws", async () => {
    expect(await lookupIssueSession(makeLinearBotEnv(errorKv), "issue-1")).toBeNull();
  });
});

// ─── storeIssueSession ──────────────────────────────────────────────────────

describe("storeIssueSession", () => {
  const session = {
    sessionId: "sess-1",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    repoOwner: "org",
    repoName: "repo",
    model: "claude-sonnet-4-5",
    createdAt: 123,
  };

  it("stores session at correct key", async () => {
    const { kv, putCalls } = createFakeKV();
    await storeIssueSession(makeLinearBotEnv(kv), "issue-1", session);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].key).toBe("issue:issue-1");
    expect(JSON.parse(putCalls[0].value)).toEqual(session);
  });

  it("uses 7-day TTL (604800s)", async () => {
    const { kv, putCalls } = createFakeKV();
    await storeIssueSession(makeLinearBotEnv(kv), "issue-1", session);
    expect(putCalls[0].options).toEqual({ expirationTtl: 86400 * 7 });
  });
});

// ─── Linear Workspace Auth Health ───────────────────────────────────────────

describe("linear auth health", () => {
  it("returns null when no auth health exists", async () => {
    const { kv } = createFakeKV();
    expect(await getLinearAuthState(makeLinearBotEnv(kv), "org-1")).toBeNull();
  });

  it("returns null for malformed auth health", async () => {
    const { kv } = createFakeKV({ "linear_auth:org-1": "{not-json" });
    expect(await getLinearAuthState(makeLinearBotEnv(kv), "org-1")).toBeNull();
  });

  it("stores connected auth health without token material", async () => {
    const { kv, store } = createFakeKV();
    const env = makeLinearBotEnv(kv);

    await setLinearAuthState(env, {
      orgId: "org-1",
      status: "connected",
      reason: "oauth_callback",
      traceId: "trace-1",
      installation: { orgName: "Acme", appUserId: "app-user-1" },
    });

    const state = JSON.parse(store.get("linear_auth:org-1") ?? "{}");
    expect(state).toMatchObject({
      schemaVersion: 1,
      orgId: "org-1",
      status: "connected",
      reason: "oauth_callback",
      lastTraceId: "trace-1",
      installation: {
        orgName: "Acme",
        appUserId: "app-user-1",
      },
    });
    expect(JSON.stringify(state)).not.toContain("access_token");
    expect(JSON.stringify(state)).not.toContain("refresh_token");
  });

  it("records unavailable fallback notification without changing auth status", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await setLinearAuthState(env, {
      orgId: "org-1",
      status: "reauthorization_required",
      reason: "refresh_invalid_grant",
    });
    const fingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "refresh_invalid_grant",
    });

    await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      agentSessionId: "agent-session-1",
      traceId: "trace-1",
    });
    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      outcome: "unavailable",
      failureReason: "missing_linear_api_key",
    });

    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "reauthorization_required",
      reason: "refresh_invalid_grant",
      lastNotification: {
        fingerprint,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        agentSessionId: "agent-session-1",
        outcome: "unavailable",
        failureReason: "missing_linear_api_key",
      },
    });
  });

  it("does not suppress an unavailable fallback when retried later", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const fingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "missing_token",
    });

    await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      outcome: "unavailable",
      failureReason: "missing_linear_api_key",
    });

    await expect(
      beginLinearAuthNotification(env, {
        orgId: "org-1",
        fingerprint,
        issueId: "issue-1",
      })
    ).resolves.toEqual({ suppressed: false });
  });

  it("suppresses repeated fallback notification fingerprints", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const fingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "missing_token",
    });

    await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      outcome: "sent",
    });

    await expect(
      beginLinearAuthNotification(env, {
        orgId: "org-1",
        fingerprint,
        issueId: "issue-1",
      })
    ).resolves.toEqual({ suppressed: true });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      lastNotification: {
        outcome: "sent",
        suppressedCount: 1,
      },
    });
  });

  it("clears stale fallback notification state when auth reconnects", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const fingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "missing_token",
    });
    await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      outcome: "sent",
    });

    await setLinearAuthState(env, {
      orgId: "org-1",
      status: "connected",
      reason: "oauth_callback",
    });

    await expect(getLinearAuthState(env, "org-1")).resolves.not.toHaveProperty("lastNotification");
  });
});

// ─── OAuth State ────────────────────────────────────────────────────────────

describe("oauth state", () => {
  it("stores OAuth state with short TTL", async () => {
    const { kv, putCalls } = createFakeKV();
    await storeOAuthState(makeLinearBotEnv(kv), "state-1");

    expect(putCalls[0]).toMatchObject({
      key: "oauth:state:state-1",
      options: { expirationTtl: 600 },
    });
  });

  it("consumes a matching OAuth state once", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await storeOAuthState(env, "state-1");

    await expect(consumeOAuthState(env, "state-1")).resolves.toBe(true);
    await expect(consumeOAuthState(env, "state-1")).resolves.toBe(false);
  });
});

// ─── isDuplicateEvent ────────────────────────────────────────────────────────

describe("isDuplicateEvent", () => {
  it("returns false on first call for a key", async () => {
    const { kv } = createFakeKV();
    expect(await isDuplicateEvent(makeLinearBotEnv(kv), "evt-1")).toBe(false);
  });

  it("returns true on second call for the same key", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await isDuplicateEvent(env, "evt-1");
    expect(await isDuplicateEvent(env, "evt-1")).toBe(true);
  });

  it("returns false for a different key", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await isDuplicateEvent(env, "evt-1");
    expect(await isDuplicateEvent(env, "evt-2")).toBe(false);
  });

  it("stores with 1-hour TTL at event:{key}", async () => {
    const { kv, putCalls } = createFakeKV();
    await isDuplicateEvent(makeLinearBotEnv(kv), "evt-1");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].key).toBe("event:evt-1");
    expect(putCalls[0].options).toEqual({ expirationTtl: 3600 });
  });
});
