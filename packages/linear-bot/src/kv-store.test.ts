import { describe, expect, it, vi } from "vitest";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getTriggerConfig,
  getUserPreferences,
  lookupIssueSession,
  storeIssueSession,
  isDuplicateEvent,
  DEFAULT_TRIGGER_CONFIG,
  LINEAR_AUTH_NOTIFICATION_ATTEMPT_LEASE_MS,
  OAUTH_STATE_TTL_MS,
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

function requireAttemptId(started: { attemptId?: string }): string {
  expect(started.attemptId).toEqual(expect.any(String));
  return started.attemptId as string;
}

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

  it("stores connected auth health", async () => {
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

    const started = await beginLinearAuthNotification(env, {
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
      attemptId: requireAttemptId(started),
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

  it("stores notification attempts with a leased attempt id", async () => {
    const now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const fingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "missing_token",
    });

    const started = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });

    expect(started.suppressed).toBe(false);
    expect(started.attemptId).toEqual(expect.any(String));
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      lastNotification: {
        fingerprint,
        attemptId: started.attemptId,
        outcome: "attempting",
        attemptedAt: now,
        leaseExpiresAt: now + LINEAR_AUTH_NOTIFICATION_ATTEMPT_LEASE_MS,
      },
    });
    nowSpy.mockRestore();
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

    const started = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      attemptId: requireAttemptId(started),
      outcome: "unavailable",
      failureReason: "missing_linear_api_key",
    });

    const retried = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });

    expect(retried).toMatchObject({ suppressed: false });
    expect(retried.attemptId).toEqual(expect.any(String));
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

    const started = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      attemptId: requireAttemptId(started),
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

  it("does not suppress an attempting notification after its lease expires", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const fingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "missing_token",
    });

    const first = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    nowSpy.mockReturnValue(1_000 + LINEAR_AUTH_NOTIFICATION_ATTEMPT_LEASE_MS + 1);

    const second = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });

    expect(second.suppressed).toBe(false);
    expect(second.attemptId).toEqual(expect.any(String));
    expect(second.attemptId).not.toBe(first.attemptId);
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      lastNotification: {
        fingerprint,
        attemptId: second.attemptId,
        outcome: "attempting",
        attemptedAt: 1_000 + LINEAR_AUTH_NOTIFICATION_ATTEMPT_LEASE_MS + 1,
      },
    });
    nowSpy.mockRestore();
  });

  it("does not complete an expired notification attempt", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const fingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "missing_token",
    });
    const started = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    const attemptId = requireAttemptId(started);
    nowSpy.mockReturnValue(1_000 + LINEAR_AUTH_NOTIFICATION_ATTEMPT_LEASE_MS + 1);

    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      attemptId,
      outcome: "sent",
    });

    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      lastNotification: {
        fingerprint,
        attemptId,
        outcome: "attempting",
      },
    });
    nowSpy.mockRestore();
  });

  it("does not complete a superseded notification attempt", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const firstFingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "missing_token",
    });
    const secondFingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-2",
      status: "reauthorization_required",
      reason: "missing_token",
    });
    const first = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint: firstFingerprint,
      issueId: "issue-1",
    });
    const firstAttemptId = requireAttemptId(first);
    const second = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint: secondFingerprint,
      issueId: "issue-2",
    });
    const secondAttemptId = requireAttemptId(second);

    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint: firstFingerprint,
      attemptId: firstAttemptId,
      outcome: "sent",
    });

    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      lastNotification: {
        fingerprint: secondFingerprint,
        attemptId: secondAttemptId,
        outcome: "attempting",
      },
    });
  });

  it("does not complete a notification attempt with the wrong attempt id", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const fingerprint = buildLinearAuthNotificationFingerprint({
      orgId: "org-1",
      issueId: "issue-1",
      status: "reauthorization_required",
      reason: "missing_token",
    });
    const started = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    const attemptId = requireAttemptId(started);

    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      attemptId: "other-attempt",
      outcome: "sent",
    });

    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      lastNotification: {
        fingerprint,
        attemptId,
        outcome: "attempting",
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
    const started = await beginLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      issueId: "issue-1",
    });
    await completeLinearAuthNotification(env, {
      orgId: "org-1",
      fingerprint,
      attemptId: requireAttemptId(started),
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
  it("signs and validates OAuth state statelessly, without touching KV", async () => {
    const { kv, putCalls } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const state = await storeOAuthState(env, "state-1");
    const kvMock = kv as unknown as {
      get: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };

    expect(state).toMatch(/^linear_oauth_state_v1\.[^.]+\.[a-f0-9]{64}$/u);
    await expect(consumeOAuthState(env, state)).resolves.toBe(true);
    await expect(consumeOAuthState(env, state)).resolves.toBe(true);
    expect(putCalls).toHaveLength(0);
    expect(kvMock.get).not.toHaveBeenCalled();
    expect(kvMock.delete).not.toHaveBeenCalled();
  });

  it("rejects unsigned OAuth state values", async () => {
    const { kv } = createFakeKV();
    await expect(consumeOAuthState(makeLinearBotEnv(kv), "state-1")).resolves.toBe(false);
  });

  it("rejects tampered OAuth state signatures", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const state = await storeOAuthState(env, "state-1");
    const tampered = `${state.slice(0, -1)}${state.endsWith("0") ? "1" : "0"}`;

    await expect(consumeOAuthState(env, tampered)).resolves.toBe(false);
  });

  it("rejects expired OAuth state", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const state = await storeOAuthState(env, "state-1");
    nowSpy.mockReturnValue(1_000 + OAUTH_STATE_TTL_MS + 1);

    await expect(consumeOAuthState(env, state)).resolves.toBe(false);
    nowSpy.mockRestore();
  });

  it("rejects OAuth state signed for a different client", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const state = await storeOAuthState(env, "state-1");

    await expect(
      consumeOAuthState(makeLinearBotEnv(kv, { LINEAR_CLIENT_ID: "other-client-id" }), state)
    ).resolves.toBe(false);
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
