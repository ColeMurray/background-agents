import { describe, expect, it } from "vitest";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getUserPreferences,
  lookupIssueSession,
  storeIssueSession,
  isDuplicateEvent,
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

  it("rejects mixed and malformed targets", async () => {
    const { kv } = createFakeKV({
      "config:team-repos": JSON.stringify({
        "team-1": [{ owner: "org", name: "repo", environmentId: "env_1" }],
      }),
    });
    expect(await getTeamRepoMapping(makeLinearBotEnv(kv))).toEqual({});
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

  it("rejects targets with neither repository nor environment identity", async () => {
    const { kv } = createFakeKV({ "config:project-repos": JSON.stringify({ "proj-1": {} }) });
    expect(await getProjectRepoMapping(makeLinearBotEnv(kv))).toEqual({});
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

  it("rejects preferences stored under a different user", async () => {
    const { kv } = createFakeKV({
      "user_prefs:user-1": JSON.stringify({ userId: "user-2", model: "model", updatedAt: 123 }),
    });
    expect(await getUserPreferences(makeLinearBotEnv(kv), "user-1")).toBeNull();
  });

  it("rejects non-finite preference timestamps", async () => {
    const { kv } = createFakeKV({
      "user_prefs:user-1": JSON.stringify({ userId: "user-1", updatedAt: "now" }),
    });
    expect(await getUserPreferences(makeLinearBotEnv(kv), "user-1")).toBeNull();
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
    expect(await lookupIssueSession(makeLinearBotEnv(kv), "issue-1")).toEqual({
      sessionId: "sess-1",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      target: { kind: "repository", owner: "org", name: "repo" },
      model: "claude-sonnet-4-5",
      createdAt: 123,
    });
  });

  it("returns null for malformed stored sessions", async () => {
    const { kv } = createFakeKV({
      "issue:issue-1": JSON.stringify({ sessionId: "sess-1", issueId: "issue-1" }),
    });

    expect(await lookupIssueSession(makeLinearBotEnv(kv), "issue-1")).toBeNull();
  });

  it("rejects mixed legacy targets", async () => {
    const { kv } = createFakeKV({
      "issue:issue-1": JSON.stringify({
        sessionId: "sess-1",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        repoOwner: "org",
        repoName: "repo",
        environmentId: "env_1",
        model: "model",
        createdAt: 123,
      }),
    });
    expect(await lookupIssueSession(makeLinearBotEnv(kv), "issue-1")).toBeNull();
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
    target: { kind: "repository" as const, owner: "org", name: "repo" },
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
