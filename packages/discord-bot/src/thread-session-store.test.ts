import { describe, expect, it } from "vitest";
import { lookupThreadSession, storeThreadSession } from "./thread-session-store";
import { createEnv, createKv } from "./test-helpers";

const session = {
  sessionId: "s1",
  repoFullName: "octo/repo",
  model: "anthropic/claude-opus-5",
  createdAt: 1,
};

describe("thread session store", () => {
  it("round-trips records with the existing key and TTL", async () => {
    const kv = createKv();
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });
    await storeThreadSession(env, "thread-1", session);
    expect(kv.put).toHaveBeenCalledWith("thread:thread-1", JSON.stringify(session), {
      expirationTtl: 30 * 24 * 60 * 60,
    });
    await expect(lookupThreadSession(env, "thread-1")).resolves.toEqual(session);
  });

  it.each([null, {}, { ...session, sessionId: "" }, { ...session, createdAt: -1 }])(
    "ignores invalid records: %j",
    async (record) => {
      const env = createEnv({
        DISCORD_KV: createKv({
          "thread:thread-1": JSON.stringify(record),
        }) as unknown as KVNamespace,
      });
      await expect(lookupThreadSession(env, "thread-1")).resolves.toBeNull();
    }
  );

  it("propagates read outages instead of treating a known thread as a new task", async () => {
    const kv = createKv();
    kv.get.mockRejectedValueOnce(new Error("KV unavailable"));
    await expect(
      lookupThreadSession(createEnv({ DISCORD_KV: kv as unknown as KVNamespace }), "thread-1")
    ).rejects.toThrow("KV unavailable");
  });
});
