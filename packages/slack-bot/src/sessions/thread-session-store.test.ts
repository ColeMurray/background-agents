import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ThreadSession } from "../types";
import {
  advanceLastPromptTs,
  buildThreadSession,
  closeThreadSession,
  isThreadClosureNoticeSent,
  isThreadSessionClosed,
  lookupThreadSession,
  markThreadClosureNoticeSent,
  reopenThreadSession,
  storeThreadSession,
} from "./thread-session-store";

function makeEnv() {
  const values = new Map<string, string>();
  const get = vi.fn(async (key: string, type?: string) => {
    const value = values.get(key);
    return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
  });
  const put = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const deleteValue = vi.fn(async (key: string) => {
    values.delete(key);
  });
  const env = {
    SLACK_KV: { get, put, delete: deleteValue } as unknown as KVNamespace,
    LOG_LEVEL: "error",
  } as Env;
  return { env, put, values };
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

  it("retains an early closure when the initial mapping is stored later", async () => {
    const { values } = mocks;
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
    const { values } = mocks;
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
    await closeThreadSession(mocks.env, "C123", "111.222", "old-session");
    const session = { ...baseSession, sessionId: "new-session" };
    await storeThreadSession(mocks.env, "C123", "111.222", session);
    expect(await lookupThreadSession(mocks.env, "C123", "111.222")).toEqual(session);
    expect(await isThreadSessionClosed(mocks.env, "C123", "111.222", "new-session")).toBe(false);
    expect(await isThreadSessionClosed(mocks.env, "C123", "111.222", "old-session")).toBe(true);
  });

  it("reopens a closed thread so a later closure notifies again", async () => {
    const session = { ...baseSession, teamId: null };
    await storeThreadSession(mocks.env, "C123", "111.222", session);
    await closeThreadSession(mocks.env, "C123", "111.222", "session-1");
    await markThreadClosureNoticeSent(mocks.env, "C123", "111.222", "session-1");
    expect(await isThreadClosureNoticeSent(mocks.env, "C123", "111.222", "session-1")).toBe(true);

    await expect(
      reopenThreadSession(mocks.env, "C123", "111.222", { ...session, closed: true })
    ).resolves.toEqual(session);
    expect(await lookupThreadSession(mocks.env, "C123", "111.222")).toEqual(session);
    expect(await isThreadClosureNoticeSent(mocks.env, "C123", "111.222", "session-1")).toBe(false);

    await closeThreadSession(mocks.env, "C123", "111.222", "session-1");
    expect(await isThreadSessionClosed(mocks.env, "C123", "111.222", "session-1")).toBe(true);
  });

  it("keeps a closure that lands while a reopen rewrites the mapping", async () => {
    const { values } = mocks;
    const session = { ...baseSession, teamId: null };
    await storeThreadSession(mocks.env, "C123", "111.222", session);
    await closeThreadSession(mocks.env, "C123", "111.222", "session-1");
    let releaseRewrite!: () => void;
    let rewriteStarted!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseRewrite = resolve;
    });
    const started = new Promise<void>((resolve) => {
      rewriteStarted = resolve;
    });
    mocks.put.mockImplementation(async (key: string, value: string) => {
      if (key === "thread:C123:111.222" && !("closed" in JSON.parse(value))) {
        rewriteStarted();
        await paused;
      }
      values.set(key, value);
    });
    const reopen = reopenThreadSession(mocks.env, "C123", "111.222", { ...session, closed: true });
    await started;
    await closeThreadSession(mocks.env, "C123", "111.222", "session-1");
    releaseRewrite();
    await reopen;
    expect(JSON.parse(values.get("thread:C123:111.222")!)).not.toHaveProperty("closed");
    expect(await lookupThreadSession(mocks.env, "C123", "111.222")).toEqual({
      ...session,
      closed: true,
    });
    expect(await isThreadSessionClosed(mocks.env, "C123", "111.222", "session-1")).toBe(true);
  });

  it("preserves valid team scope and rejects malformed boundary metadata", async () => {
    for (const teamId of [undefined, null, "team-a"]) {
      const session = buildThreadSession(
        "session-1",
        { kind: "none" },
        "openai/gpt-5.4",
        undefined,
        undefined,
        teamId
      );
      if (teamId === undefined) expect(session).not.toHaveProperty("teamId");
      else expect(session).toHaveProperty("teamId", teamId);
      await storeThreadSession(mocks.env, "C123", "111.222", session);
      expect(await lookupThreadSession(mocks.env, "C123", "111.222")).toEqual(session);
    }
    for (const record of [
      { ...baseSession, teamId: "" },
      { ...baseSession, teamId: 123 },
      { ...baseSession, closed: false },
    ]) {
      mocks.values.set("thread:C123:111.222", JSON.stringify(record));
      expect(await lookupThreadSession(mocks.env, "C123", "111.222")).toBeNull();
    }
  });
});
