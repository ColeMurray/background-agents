import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ThreadSession } from "../types";
import {
  advanceLastPromptTs,
  buildThreadSession,
  clearThreadSession,
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

  beforeEach(() => {
    mocks = makeEnv();
  });

  it("stores sessions under the thread key for seven days", async () => {
    const session: ThreadSession = {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: 123,
    };

    await storeThreadSession(mocks.env, "C123", "111.222", session);

    expect(mocks.put).toHaveBeenCalledWith("thread:C123:111.222", JSON.stringify(session), {
      expirationTtl: 7 * 24 * 60 * 60,
    });
  });

  it("reads and clears sessions using the same key", async () => {
    const session: ThreadSession = {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: 123,
    };
    mocks.get.mockResolvedValue(session);

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(session);
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

  it("treats invalid values and KV failures as cache misses", async () => {
    mocks.get.mockResolvedValueOnce("invalid").mockRejectedValueOnce(new Error("KV unavailable"));

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toBeNull();
    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toBeNull();
  });

  it.each([
    {},
    [],
    { sessionId: "session-1" },
    {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: "123",
    },
    {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      reasoningEffort: 123,
      createdAt: 123,
    },
    {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: 123,
      lastPromptTs: 333.444,
    },
  ])("rejects malformed records: %j", async (record) => {
    mocks.get.mockResolvedValue(record);

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toBeNull();
  });

  it("accepts persisted records with and without reasoning effort", async () => {
    const base: ThreadSession = {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: 123,
    };
    const withReasoning = { ...base, reasoningEffort: "high" };
    mocks.get.mockResolvedValueOnce(base).mockResolvedValueOnce(withReasoning);

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(base);
    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(withReasoning);
  });

  it("accepts persisted records with and without a last prompt ts", async () => {
    const base: ThreadSession = {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: 123,
    };
    const withLastPrompt = { ...base, lastPromptTs: "333.444" };
    mocks.get.mockResolvedValueOnce(base).mockResolvedValueOnce(withLastPrompt);

    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(base);
    await expect(lookupThreadSession(mocks.env, "C123", "111.222")).resolves.toEqual(
      withLastPrompt
    );
  });

  describe("advanceLastPromptTs", () => {
    const stored: ThreadSession = {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: 123,
      lastPromptTs: "222.333",
    };

    it("advances the checkpoint when the new ts is newer", async () => {
      mocks.get.mockResolvedValue(stored);

      await advanceLastPromptTs(mocks.env, "C123", "111.222", "333.444");

      expect(mocks.put).toHaveBeenCalledWith(
        "thread:C123:111.222",
        JSON.stringify({ ...stored, lastPromptTs: "333.444" }),
        { expirationTtl: 7 * 24 * 60 * 60 }
      );
    });

    it("stamps mappings that have no checkpoint yet", async () => {
      const { lastPromptTs: _legacy, ...legacy } = stored;
      mocks.get.mockResolvedValue(legacy);

      await advanceLastPromptTs(mocks.env, "C123", "111.222", "333.444");

      expect(mocks.put).toHaveBeenCalledWith(
        "thread:C123:111.222",
        JSON.stringify({ ...legacy, lastPromptTs: "333.444" }),
        { expirationTtl: 7 * 24 * 60 * 60 }
      );
    });

    it("does not move the checkpoint backwards on out-of-order completion", async () => {
      mocks.get.mockResolvedValue({ ...stored, lastPromptTs: "999.999" });

      await advanceLastPromptTs(mocks.env, "C123", "111.222", "333.444");

      expect(mocks.put).not.toHaveBeenCalled();
    });

    it("does not resurrect a cleared mapping", async () => {
      mocks.get.mockResolvedValue(null);

      await advanceLastPromptTs(mocks.env, "C123", "111.222", "333.444");

      expect(mocks.put).not.toHaveBeenCalled();
    });
  });

  it("handles KV write and delete failures", async () => {
    const session: ThreadSession = {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: 123,
    };
    mocks.put.mockRejectedValue(new Error("KV write unavailable"));
    mocks.deleteValue.mockRejectedValue(new Error("KV delete unavailable"));

    await expect(
      storeThreadSession(mocks.env, "C123", "111.222", session)
    ).resolves.toBeUndefined();
    await expect(clearThreadSession(mocks.env, "C123", "111.222")).resolves.toBeUndefined();
  });
});
