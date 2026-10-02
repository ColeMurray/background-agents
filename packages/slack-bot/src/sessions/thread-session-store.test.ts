import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ThreadSession } from "../types";
import {
  advanceLastPromptTs,
  buildThreadSession,
  clearThreadSession,
  closeThreadSession,
  isThreadSessionClosed,
  lookupThreadSession,
  storeThreadSession,
} from "./thread-session-store";

function makeEnv() {
  const get = vi.fn();
  const put = vi.fn();
  const deleteValue = vi.fn();
  const env = {
    SLACK_KV: { get, put, delete: deleteValue } as unknown as KVNamespace,
    LOG_LEVEL: "error",
  } as Env;
  return { env, get, put, deleteValue };
}

describe("thread session store", () => {
  let mocks: ReturnType<typeof makeEnv>;
  const baseSession: ThreadSession = {
    sessionId: "session-1",
    repoId: "acme/app",
    repoFullName: "acme/app",
    model: "openai/gpt-5.4",
    createdAt: 123,
  };

  beforeEach(() => {
    mocks = makeEnv();
  });

  function useMemoryKv() {
    const values = new Map<string, string>();
    mocks.get.mockImplementation(async (key: string, type?: string) => {
      const value = values.get(key);
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
    });
    mocks.put.mockImplementation(async (key: string, value: string) => {
      values.set(key, value);
    });
    return values;
  }

  it("retains an early closure when the initial mapping is stored later", async () => {
    const values = useMemoryKv();
    await closeThreadSession(mocks.env, "C123", "111.222", "session-1");
    expect(await isThreadSessionClosed(mocks.env, "C123", "111.222", "session-1")).toBe(true);
    const session = { ...baseSession, teamId: null };
    await storeThreadSession(mocks.env, "C123", "111.222", session);
    expect(JSON.parse(values.get("thread:C123:111.222")!)).toEqual({ ...session, closed: true });
    expect(await lookupThreadSession(mocks.env, "C123", "111.222")).toEqual({
      ...session,
      closed: true,
    });
    expect(mocks.put).toHaveBeenCalledWith("thread-closed:C123:111.222:session-1", "1", {
      expirationTtl: 7 * 24 * 60 * 60,
    });
  });

  it("overlays closure after a stale checkpoint write overwrites the closed mapping", async () => {
    const values = useMemoryKv();
    const session = { ...baseSession, lastPromptTs: "222.333" };
    await storeThreadSession(mocks.env, "C123", "111.222", session);
    let releaseCheckpoint!: () => void;
    let checkpointStarted!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const started = new Promise<void>((resolve) => {
      checkpointStarted = resolve;
    });
    mocks.put.mockImplementation(async (key: string, value: string) => {
      if (key === "thread:C123:111.222" && JSON.parse(value).lastPromptTs === "333.444") {
        checkpointStarted();
        await paused;
      }
      values.set(key, value);
    });
    const checkpoint = advanceLastPromptTs(mocks.env, "C123", "111.222", "333.444");
    await started;
    await closeThreadSession(mocks.env, "C123", "111.222", "session-1");
    releaseCheckpoint();
    await checkpoint;
    expect(JSON.parse(values.get("thread:C123:111.222")!)).not.toHaveProperty("closed");
    expect(await lookupThreadSession(mocks.env, "C123", "111.222")).toMatchObject({
      closed: true,
      lastPromptTs: "333.444",
    });
    expect(await isThreadSessionClosed(mocks.env, "C123", "111.222", "session-1")).toBe(true);
  });

  it("keeps closure scoped to the session rather than poisoning a replacement mapping", async () => {
    useMemoryKv();
    await closeThreadSession(mocks.env, "C123", "111.222", "old-session");
    const session = { ...baseSession, sessionId: "new-session" };
    await storeThreadSession(mocks.env, "C123", "111.222", session);
    expect(await lookupThreadSession(mocks.env, "C123", "111.222")).toEqual(session);
    expect(await isThreadSessionClosed(mocks.env, "C123", "111.222", "new-session")).toBe(false);
    expect(await isThreadSessionClosed(mocks.env, "C123", "111.222", "old-session")).toBe(true);
  });

  it("stores sessions under the thread key for seven days", async () => {
    await storeThreadSession(mocks.env, "C123", "111.222", baseSession);

    expect(mocks.put).toHaveBeenCalledWith("thread:C123:111.222", JSON.stringify(baseSession), {
      expirationTtl: 7 * 24 * 60 * 60,
    });
  });

  it("reads and clears sessions using the same key", async () => {
    mocks.get.mockResolvedValue(baseSession);

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(baseSession);
    expect(mocks.get).toHaveBeenCalledWith("thread:C123:111.222", "json");

    await clearThreadSession(mocks.env, "C123", "111.222");
    expect(mocks.deleteValue).toHaveBeenCalledWith("thread:C123:111.222");
  });

  it("builds repository session metadata", () => {
    vi.spyOn(Date, "now").mockReturnValue(456);

    expect(
      buildThreadSession(
        "session-1",
        {
          kind: "repository",
          repo: {
            id: "acme/app",
            owner: "acme",
            name: "app",
            fullName: "acme/app",
            displayName: "acme/app",
            description: "Application repository",
            defaultBranch: "main",
            private: true,
          },
        },
        "openai/gpt-5.4",
        "high",
        "111.222"
      )
    ).toEqual({
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      createdAt: 456,
      lastPromptTs: "111.222",
    });
  });

  it("builds no-repository session metadata", () => {
    vi.spyOn(Date, "now").mockReturnValue(456);

    expect(buildThreadSession("session-1", { kind: "none" }, "openai/gpt-5.4")).toEqual({
      sessionId: "session-1",
      repoId: "__no_repository__",
      repoFullName: "No repository",
      model: "openai/gpt-5.4",
      reasoningEffort: undefined,
      createdAt: 456,
      lastPromptTs: undefined,
    });
  });

  it("treats invalid values and KV failures as cache misses", async () => {
    mocks.get.mockResolvedValueOnce("invalid").mockRejectedValueOnce(new Error("KV unavailable"));

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toBeNull();
    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toBeNull();
  });

  it.each([
    {},
    [],
    { sessionId: "session-1" },
    { ...baseSession, createdAt: "123" },
    { ...baseSession, reasoningEffort: 123 },
    { ...baseSession, lastPromptTs: 333.444 },
  ])("rejects malformed records: %j", async (record) => {
    mocks.get.mockResolvedValue(record);

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toBeNull();
  });

  it("accepts persisted records with and without reasoning effort", async () => {
    const withReasoning = { ...baseSession, reasoningEffort: "high" };
    const records = [baseSession, withReasoning];
    mocks.get.mockImplementation(async (_key: string, type?: string) =>
      type === "json" ? records.shift() : null
    );

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(baseSession);
    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(withReasoning);
  });

  it("accepts persisted records with and without a last prompt ts", async () => {
    const withLastPrompt = { ...baseSession, lastPromptTs: "333.444" };
    const records = [baseSession, withLastPrompt];
    mocks.get.mockImplementation(async (_key: string, type?: string) =>
      type === "json" ? records.shift() : null
    );

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(baseSession);
    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(
      withLastPrompt
    );
  });

  describe("advanceLastPromptTs", () => {
    it("keeps the checkpoint monotonic across exact microsecond fractions", async () => {
      mocks.get.mockResolvedValue({
        ...baseSession,
        lastPromptTs: "9999999999999999.000002",
      });

      await advanceLastPromptTs(mocks.env, "C123", "111.222", "9999999999999999.000001");

      expect(mocks.put).not.toHaveBeenCalled();
    });

    it("does not resurrect a cleared mapping", async () => {
      mocks.get.mockResolvedValue(null);

      await advanceLastPromptTs(mocks.env, "C123", "111.222", "333.444");

      expect(mocks.put).not.toHaveBeenCalled();
    });
  });

  it("handles KV write and delete failures", async () => {
    mocks.put.mockRejectedValue(new Error("KV write unavailable"));
    mocks.deleteValue.mockRejectedValue(new Error("KV delete unavailable"));

    await expect(
      storeThreadSession(mocks.env, "C123", "111.222", baseSession)
    ).resolves.toBeUndefined();
    await expect(clearThreadSession(mocks.env, "C123", "111.222")).resolves.toBeUndefined();
  });
});
