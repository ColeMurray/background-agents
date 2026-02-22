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
} from "./kv-store";
import type { Env } from "./types";

// ─── Fake KVNamespace ────────────────────────────────────────────────────────

interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

function createFakeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const putCalls: PutCall[] = [];

  const kv = {
    async get(key: string, type?: string) {
      const val = store.get(key) ?? null;
      if (val === null) return null;
      if (type === "json") return JSON.parse(val);
      return val;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value);
      putCalls.push({ key, value, options });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };

  return { kv: kv as unknown as KVNamespace, store, putCalls };
}

const errorKv = {
  async get() {
    throw new Error("KV error");
  },
} as unknown as KVNamespace;

function makeEnv(kv: KVNamespace): Env {
  return { LINEAR_KV: kv } as unknown as Env;
}

// ─── getTeamRepoMapping ──────────────────────────────────────────────────────

describe("getTeamRepoMapping", () => {
  it("returns {} when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await getTeamRepoMapping(makeEnv(kv))).toEqual({});
  });

  it("returns parsed mapping from KV", async () => {
    const mapping = { "team-1": [{ owner: "org", name: "repo" }] };
    const { kv } = createFakeKV({ "config:team-repos": JSON.stringify(mapping) });
    expect(await getTeamRepoMapping(makeEnv(kv))).toEqual(mapping);
  });

  it("returns {} when KV throws", async () => {
    expect(await getTeamRepoMapping(makeEnv(errorKv))).toEqual({});
  });
});

// ─── getProjectRepoMapping ───────────────────────────────────────────────────

describe("getProjectRepoMapping", () => {
  it("returns {} when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await getProjectRepoMapping(makeEnv(kv))).toEqual({});
  });

  it("returns parsed mapping from KV", async () => {
    const mapping = { "proj-1": { owner: "org", name: "repo" } };
    const { kv } = createFakeKV({ "config:project-repos": JSON.stringify(mapping) });
    expect(await getProjectRepoMapping(makeEnv(kv))).toEqual(mapping);
  });

  it("returns {} when KV throws", async () => {
    expect(await getProjectRepoMapping(makeEnv(errorKv))).toEqual({});
  });
});

// ─── getTriggerConfig ────────────────────────────────────────────────────────

describe("getTriggerConfig", () => {
  it("returns defaults when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await getTriggerConfig(makeEnv(kv))).toEqual(DEFAULT_TRIGGER_CONFIG);
  });

  it("merges partial config with defaults", async () => {
    const partial = { autoTriggerOnCreate: true };
    const { kv } = createFakeKV({ "config:triggers": JSON.stringify(partial) });
    expect(await getTriggerConfig(makeEnv(kv))).toEqual({
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
    expect(await getTriggerConfig(makeEnv(kv))).toEqual(full);
  });

  it("returns defaults when KV throws", async () => {
    expect(await getTriggerConfig(makeEnv(errorKv))).toEqual(DEFAULT_TRIGGER_CONFIG);
  });
});

// ─── getUserPreferences ──────────────────────────────────────────────────────

describe("getUserPreferences", () => {
  it("returns null when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await getUserPreferences(makeEnv(kv), "user-1")).toBeNull();
  });

  it("returns parsed preferences", async () => {
    const prefs = { userId: "user-1", model: "claude-opus-4-5", updatedAt: 123 };
    const { kv } = createFakeKV({ "user_prefs:user-1": JSON.stringify(prefs) });
    expect(await getUserPreferences(makeEnv(kv), "user-1")).toEqual(prefs);
  });

  it("returns null when KV throws", async () => {
    expect(await getUserPreferences(makeEnv(errorKv), "user-1")).toBeNull();
  });
});

// ─── lookupIssueSession ─────────────────────────────────────────────────────

describe("lookupIssueSession", () => {
  it("returns null when KV has no data", async () => {
    const { kv } = createFakeKV();
    expect(await lookupIssueSession(makeEnv(kv), "issue-1")).toBeNull();
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
    expect(await lookupIssueSession(makeEnv(kv), "issue-1")).toEqual(session);
  });

  it("returns null when KV throws", async () => {
    expect(await lookupIssueSession(makeEnv(errorKv), "issue-1")).toBeNull();
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
    await storeIssueSession(makeEnv(kv), "issue-1", session);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].key).toBe("issue:issue-1");
    expect(JSON.parse(putCalls[0].value)).toEqual(session);
  });

  it("uses 7-day TTL (604800s)", async () => {
    const { kv, putCalls } = createFakeKV();
    await storeIssueSession(makeEnv(kv), "issue-1", session);
    expect(putCalls[0].options).toEqual({ expirationTtl: 86400 * 7 });
  });
});

// ─── isDuplicateEvent ────────────────────────────────────────────────────────

describe("isDuplicateEvent", () => {
  it("returns false on first call for a key", async () => {
    const { kv } = createFakeKV();
    expect(await isDuplicateEvent(makeEnv(kv), "evt-1")).toBe(false);
  });

  it("returns true on second call for the same key", async () => {
    const { kv } = createFakeKV();
    const env = makeEnv(kv);
    await isDuplicateEvent(env, "evt-1");
    expect(await isDuplicateEvent(env, "evt-1")).toBe(true);
  });

  it("returns false for a different key", async () => {
    const { kv } = createFakeKV();
    const env = makeEnv(kv);
    await isDuplicateEvent(env, "evt-1");
    expect(await isDuplicateEvent(env, "evt-2")).toBe(false);
  });

  it("stores with 1-hour TTL at event:{key}", async () => {
    const { kv, putCalls } = createFakeKV();
    await isDuplicateEvent(makeEnv(kv), "evt-1");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].key).toBe("event:evt-1");
    expect(putCalls[0].options).toEqual({ expirationTtl: 3600 });
  });
});
